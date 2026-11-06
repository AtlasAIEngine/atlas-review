/**
 * ChangeSets Panel Component
 * Displays and manages changesets for a project
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import toast from '@/lib/toast';
import { changesetApi, devServerApi, atlasHostingApi, reviewApi, normalizeCommitSha, shortCommitSha } from '@/services/api';
import type { AvailableChecks, DevServer, ProductionStatus, VerifyConfig } from '@/services/api';
import DiffViewer from '@/components/DiffViewer';
import PublishPanel from '@/components/PublishPanel';
import type { ChangeSetIndex, ChangeSet, VerificationStatus, ChangeSetRiskFlags, ChangeSetAlsoIn, ChangeSetDeployment, ReviewStatus } from '@/types';
import { getReviewActionButtonStyle, getReviewToneVars } from './review/ReviewChrome';

interface ChangeSetsPanelProps {
  projectId: string;
  lastDeploymentUrl?: string | null;
  lastDeploymentAt?: string | null;
  onDeploymentComplete?: (url: string) => void;
  onOpenGlobalSettingsSection?: (section: 'github' | 'cloud') => void;
  onOpenReview?: (changesetId: string, title: string) => void;
}

function ChangeSetsPanel({ projectId, lastDeploymentUrl, lastDeploymentAt, onDeploymentComplete, onOpenGlobalSettingsSection, onOpenReview }: ChangeSetsPanelProps) {
  const [changesets, setChangesets] = useState<ChangeSetIndex[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedChangeset, setExpandedChangeset] = useState<ChangeSet | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [isReverting, setIsReverting] = useState<string | null>(null);
  const [isReapplying, setIsReapplying] = useState<string | null>(null);
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null);
  const [isCommitting, setIsCommitting] = useState<string | null>(null);
  const [commitModalId, setCommitModalId] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [isGitRepo, setIsGitRepo] = useState<boolean>(false);
  const [availableChecks, setAvailableChecks] = useState<AvailableChecks | null>(null);
  const [verifyConfig, setVerifyConfig] = useState<VerifyConfig>({ checks: [], lint: true, unit: true, e2e: true, autoRun: 'on_changeset' });
  const [isRunningVerification, setIsRunningVerification] = useState<string | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<string | null>(null);
  const [isPublishPanelOpen, setIsPublishPanelOpen] = useState(false);
  const [publishChangesetId, setPublishChangesetId] = useState<string | null>(null);
  const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null);
  const [editingSummaryText, setEditingSummaryText] = useState('');
  const [isSavingSummary, setIsSavingSummary] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<DevServer | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [productionStatus, setProductionStatus] = useState<ProductionStatus | null>(null);

  // Review state
  const [isRunningReview, setIsRunningReview] = useState<string | null>(null);
  const [expandedReview, setExpandedReview] = useState<string | null>(null);

  // Filter/sort state
  type FilterMode = 'all' | 'reviewed' | 'unreviewed' | 'high-risk';
  type SortMode = 'newest' | 'risk';
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [sortMode, setSortMode] = useState<SortMode>('newest');

  // Risk sort order
  const RISK_SORT: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const neutralTone = getReviewToneVars('neutral');

  // Filtered + sorted changesets
  const filteredChangesets = useMemo(() => {
    let list = changesets;

    // Filter
    if (filterMode === 'reviewed') {
      list = list.filter(cs => cs.reviewStatus === 'reviewed');
    } else if (filterMode === 'unreviewed') {
      list = list.filter(cs => !cs.reviewStatus || cs.reviewStatus === 'none');
    } else if (filterMode === 'high-risk') {
      list = list.filter(cs => cs.reviewRiskLevel === 'high' || cs.reviewRiskLevel === 'critical');
    }

    // Sort
    if (sortMode === 'risk') {
      list = [...list].sort((a, b) => {
        const aRisk = RISK_SORT[a.reviewRiskLevel || 'low'] ?? 4;
        const bRisk = RISK_SORT[b.reviewRiskLevel || 'low'] ?? 4;
        if (aRisk !== bRisk) return aRisk - bRisk;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    }
    // 'newest' is already the default order from the API

    return list;
  }, [changesets, filterMode, sortMode]);

  const activeReviewKey = useMemo(() => (
    changesets
      .filter(cs => cs.reviewStatus === 'queued' || cs.reviewStatus === 'reviewing')
      .map(cs => cs.id)
      .join(',')
  ), [changesets]);

  // Load changesets, git status, available checks, and production status when projectId changes
  useEffect(() => {
    if (projectId) {
      loadChangesets();
      loadGitStatus();
      loadAvailableChecks();
      loadProductionStatus();
    }
  }, [projectId]);

  const loadProductionStatus = async () => {
    try {
      const response = await atlasHostingApi.getProductionStatus(projectId);
      setProductionStatus(response);
    } catch (error) {
      console.error('Failed to load production status:', error);
      setProductionStatus(null);
    }
  };

  const loadGitStatus = async () => {
    try {
      const response = await changesetApi.getGitStatus(projectId);
      setIsGitRepo(response.isGitRepo);
    } catch (error) {
      console.error('Failed to load git status:', error);
      setIsGitRepo(false);
    }
  };

  const loadAvailableChecks = async () => {
    try {
      const [response, config] = await Promise.all([
        changesetApi.getAvailableChecks(projectId),
        changesetApi.getVerifyConfig(projectId).catch(() => ({ checks: [], lint: true, unit: true, e2e: true, autoRun: 'on_changeset' as const })),
      ]);
      setAvailableChecks(response);
      setVerifyConfig(config);
    } catch (error) {
      console.error('Failed to load available checks:', error);
      setAvailableChecks(null);
    }
  };

  const loadPreviewStatus = async () => {
    setIsLoadingPreview(true);
    try {
      const response = await devServerApi.getStatus(projectId);
      setPreviewStatus(response.devServer);
    } catch (error) {
      console.error('Failed to load preview status:', error);
      setPreviewStatus(null);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleToggleVerifyCheck = async (checkType: 'lint' | 'unit' | 'e2e') => {
    const newConfig = { ...verifyConfig, [checkType]: !verifyConfig[checkType] };
    setVerifyConfig(newConfig);
    try {
      await changesetApi.updateVerifyConfig(projectId, newConfig);
    } catch {
      setVerifyConfig(verifyConfig); // Revert on error
    }
  };

  const handleRunVerification = async (changesetId: string) => {
    if (!availableChecks) return;

    const hasChecks = (availableChecks?.checks?.length || 0) > 0 || Boolean(availableChecks?.hasChecks);
    if (!hasChecks) {
      toast.error('No verification checks available for this project');
      return;
    }

    setIsRunningVerification(changesetId);

    try {
      const result = await changesetApi.runVerification(projectId, changesetId);

      // Update the expanded changeset with new verification data and status
      if (expandedChangeset && expandedChangeset.id === changesetId) {
        setExpandedChangeset({
          ...expandedChangeset,
          verification: result.verification,
          status: result.status || expandedChangeset.status,
          ...(result.commitSha ? { commitSha: result.commitSha } : {}),
        });
      }

      // Update the changeset list with new verification, status, and commit info
      setChangesets(prev =>
        prev.map(cs =>
          cs.id === changesetId
            ? {
                ...cs,
                verification: result.verification,
                status: result.status || cs.status,
                ...(result.commitSha ? { commitSha: result.commitSha } : {}),
              }
            : cs
        )
      );

      // Count pass/fail
      const passed = Object.values(result.results).filter(r => r.status === 'pass').length;
      const failed = Object.values(result.results).filter(r => r.status === 'fail').length;

      if (failed === 0) {
        if (result.autoCommitted) {
          const commitLabel = shortCommitSha(result.commitSha) || 'unknown';
          toast.success(`All ${passed} checks passed - auto-committed ${commitLabel}`);
        } else {
          toast.success(`All ${passed} checks passed`);
        }
      } else {
        toast.error(`${failed} check(s) failed, ${passed} passed`);
      }
    } catch (error: any) {
      console.error('Failed to run verification:', error);
      toast.error(error.response?.data?.error || 'Failed to run verification');
    } finally {
      setIsRunningVerification(null);
    }
  };

  const handleRunReview = async (changesetId: string) => {
    const currentStatus = (
      expandedChangeset?.id === changesetId
        ? expandedChangeset.reviewStatus
        : changesets.find(cs => cs.id === changesetId)?.reviewStatus
    ) || 'none';
    if (currentStatus === 'queued' || currentStatus === 'reviewing') {
      return;
    }

    setIsRunningReview(changesetId);
    try {
      await reviewApi.enqueue(projectId, changesetId, currentStatus === 'reviewed');

      // Optimistic queued status update.
      if (expandedChangeset && expandedChangeset.id === changesetId) {
        setExpandedChangeset({
          ...expandedChangeset,
          reviewStatus: 'queued' as ReviewStatus,
        });
      }

      // Update list view
      setChangesets(prev =>
        prev.map(cs =>
          cs.id === changesetId
            ? {
                ...cs,
                reviewStatus: 'queued' as ReviewStatus,
              }
            : cs
        )
      );

      toast.success('Review queued');
    } catch (error: any) {
      console.error('Review failed:', error);
      const errMsg = error.response?.data?.error || error.message || 'Review failed';
      toast.error(errMsg);

      // Update status to failed in list
      setChangesets(prev =>
        prev.map(cs =>
          cs.id === changesetId
            ? { ...cs, reviewStatus: 'failed' as ReviewStatus }
            : cs
        )
      );
    } finally {
      setIsRunningReview(null);
    }
  };

  // Poll while one or more reviews are queued/running.
  useEffect(() => {
    if (!projectId) return;
    const activeReviewIds = activeReviewKey ? activeReviewKey.split(',') : [];
    if (activeReviewIds.length === 0) return;

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const response = await changesetApi.list(projectId);
        if (cancelled) return;
        setChangesets(response.changesets);

        if (expandedId && activeReviewIds.includes(expandedId)) {
          const detail = await changesetApi.get(projectId, expandedId);
          if (!cancelled) {
            setExpandedChangeset(detail.changeset);
          }
        }
      } catch (error) {
        console.error('Failed to poll review status:', error);
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projectId, expandedId, activeReviewKey]);

  // Listen for changeset_created events from socket
  useEffect(() => {
    const handleChangesetCreated = (e: Event) => {
      // Reload changesets when a new one is created
      loadChangesets();
      // Show toast notification for watcher-detected changesets
      const detail = (e as CustomEvent).detail;
      if (detail?.source === 'git_watcher') {
        toast(`New commits detected: ${detail.title || detail.displayId}`, { icon: '\uD83D\uDD0D' });
      }
    };

    window.addEventListener('atlas-changeset-created', handleChangesetCreated);
    return () => {
      window.removeEventListener('atlas-changeset-created', handleChangesetCreated);
    };
  }, [projectId]);

  // Poll for auto-verification/auto-commit status updates
  useEffect(() => {
    // Find the latest changeset that might be undergoing auto-verification
    const latestChangeset = changesets[0];
    const shouldPoll = latestChangeset &&
      latestChangeset.status === 'applied' &&
      !latestChangeset.commitSha;

    if (!shouldPoll) return;

    // Poll every 2 seconds for up to 30 seconds to catch auto-verification/auto-commit
    let pollCount = 0;
    const maxPolls = 15; // 15 polls * 2 seconds = 30 seconds max

    const interval = setInterval(async () => {
      pollCount++;
      await loadChangesets();

      // Stop polling if max reached or changeset is no longer in 'applied' status
      if (pollCount >= maxPolls) {
        clearInterval(interval);
      }
    }, 2000);

    // Also stop polling early if status changes
    return () => clearInterval(interval);
  }, [changesets[0]?.id, changesets[0]?.status, changesets[0]?.commitSha]);

  const loadChangesets = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await changesetApi.list(projectId);
      setChangesets(response.changesets);
    } catch (error) {
      console.error('Failed to load changesets:', error);
      setLoadError('Failed to load changesets. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  const handleToggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedChangeset(null);
      setPreviewStatus(null);
      return;
    }

    setExpandedId(id);
    setIsLoadingDetail(true);

    try {
      const response = await changesetApi.get(projectId, id);
      setExpandedChangeset(response.changeset);
      // Also fetch preview status when expanding
      loadPreviewStatus();
    } catch (error) {
      console.error('Failed to load changeset details:', error);
      toast.error('Failed to load changeset details');
      setExpandedId(null);
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const handleRevert = async (changeset: ChangeSetIndex) => {
    // Require confirmation for changesets with many files
    if (changeset.fileCount > 10 && confirmRevert !== changeset.id) {
      setConfirmRevert(changeset.id);
      return;
    }

    setIsReverting(changeset.id);
    setConfirmRevert(null);

    try {
      const result = await changesetApi.revert(projectId, changeset.id);
      toast.success(result.message);

      // Reload changesets to get updated status
      await loadChangesets();

      // If this changeset was expanded, reload its details
      if (expandedId === changeset.id) {
        const response = await changesetApi.get(projectId, changeset.id);
        setExpandedChangeset(response.changeset);
      }
    } catch (error: any) {
      console.error('Failed to revert changeset:', error);
      toast.error(error.response?.data?.error || 'Failed to revert changeset');
    } finally {
      setIsReverting(null);
    }
  };

  const handleReapply = async (changeset: ChangeSetIndex) => {
    setIsReapplying(changeset.id);

    try {
      const result = await changesetApi.reapply(projectId, changeset.id);
      toast.success(result.message);

      // Reload changesets to get updated status
      await loadChangesets();

      // If this changeset was expanded, reload its details
      if (expandedId === changeset.id) {
        const response = await changesetApi.get(projectId, changeset.id);
        setExpandedChangeset(response.changeset);
      }
    } catch (error: any) {
      console.error('Failed to reapply changeset:', error);
      toast.error(error.response?.data?.error || 'Failed to reapply changeset');
    } finally {
      setIsReapplying(null);
    }
  };

  const openCommitModal = (changeset: ChangeSetIndex) => {
    setCommitMessage(changeset.title);
    setCommitModalId(changeset.id);
  };

  const handleCommit = async () => {
    if (!commitModalId) return;

    setIsCommitting(commitModalId);
    setCommitModalId(null);

    try {
      const result = await changesetApi.commit(projectId, commitModalId, commitMessage);
      const commitLabel = shortCommitSha(result.commitSha) || 'unknown';
      toast.success(`Committed: ${commitLabel}`);

      // Update local state with commit SHA, message, and status
      setChangesets(prev =>
        prev.map(cs =>
          cs.id === commitModalId
            ? { ...cs, commitSha: result.commitSha, commitMessage, status: 'committed' as const }
            : cs
        )
      );

      // If this changeset was expanded, update its details
      if (expandedChangeset && expandedChangeset.id === commitModalId) {
        setExpandedChangeset({
          ...expandedChangeset,
          commitSha: result.commitSha,
          commitMessage,
          status: 'committed',
        });
      }
    } catch (error: any) {
      console.error('Failed to commit changeset:', error);
      toast.error(error.response?.data?.error || 'Failed to commit changeset');
    } finally {
      setIsCommitting(null);
      setCommitMessage('');
    }
  };

  const handleEditSummary = (changeset: ChangeSetIndex) => {
    setEditingSummaryId(changeset.id);
    setEditingSummaryText(changeset.summary || '');
  };

  const handleSaveSummary = async () => {
    if (!editingSummaryId) return;

    setIsSavingSummary(true);
    try {
      await changesetApi.updateSummary(projectId, editingSummaryId, editingSummaryText);

      // Update local state
      setChangesets(prev =>
        prev.map(cs =>
          cs.id === editingSummaryId ? { ...cs, summary: editingSummaryText } : cs
        )
      );

      // Also update expanded changeset if it's the one being edited
      if (expandedChangeset && expandedChangeset.id === editingSummaryId) {
        setExpandedChangeset({ ...expandedChangeset, summary: editingSummaryText });
      }

      toast.success('Summary updated');
    } catch (error: any) {
      console.error('Failed to update summary:', error);
      toast.error(error.response?.data?.error || 'Failed to update summary');
    } finally {
      setIsSavingSummary(false);
      setEditingSummaryId(null);
      setEditingSummaryText('');
    }
  };

  const handleCancelEditSummary = () => {
    setEditingSummaryId(null);
    setEditingSummaryText('');
  };

  const handleOpenPreview = () => {
    // Dispatch event to switch to Preview tab
    window.dispatchEvent(new CustomEvent('atlas-navigate-to-preview'));
  };

  const handleStartPreview = () => {
    // Dispatch event to start the dev server preview
    window.dispatchEvent(new CustomEvent('atlas-start-preview', { detail: { projectId } }));
  };

  const formatRelativeTime = (timestamp: string) => {
    const diff = Date.now() - new Date(timestamp).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  };

  const getSourceIcon = (source: string) => {
    switch (source) {
      case 'agent':
        return (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        );
      case 'visual_edit':
        return (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
          </svg>
        );
      case 'workflow':
        return (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
          </svg>
        );
      case 'git_watcher':
        return (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        );
      case 'baseline':
        return (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm0 0h18" />
          </svg>
        );
      default:
        return (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        );
    }
  };

  const getDeploymentCapsule = (deployment: ChangeSetDeployment | null | undefined, isProduction?: boolean) => {
    if (!deployment) return null;

    const isSuccess = deployment.status === 'succeeded';
    const isFailed = deployment.status === 'failed';
    const isRunning = deployment.status === 'running' || deployment.status === 'queued';

    if (isRunning) {
      return (
        <span className="px-2 py-0.5 rounded text-xs bg-accent-yellow/20 text-accent-yellow border border-accent-yellow/30 flex items-center gap-1">
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          Deploying
        </span>
      );
    }

    if (isFailed) {
      return (
        <span
          className="px-2 py-0.5 rounded text-xs bg-accent-red/20 text-accent-red border border-accent-red/30 flex items-center gap-1"
          title={deployment.errorMessage || 'Deployment failed'}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          Failed
        </span>
      );
    }

    if (isSuccess && deployment.url) {
      // Truncate URL for display
      let displayUrl = '';
      try {
        const url = new URL(deployment.url);
        displayUrl = url.hostname.replace(/^www\./, '');
        if (displayUrl.length > 20) {
          displayUrl = displayUrl.substring(0, 18) + '...';
        }
      } catch {
        displayUrl = deployment.url.substring(0, 20);
      }

      return (
        <div className="flex items-center gap-1">
          {isProduction ? (
            <span className="px-2 py-0.5 rounded text-xs bg-accent-green text-content font-medium animate-pulse">
              LIVE
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded text-xs bg-accent-blue/20 text-accent-blue border border-accent-blue/30">
              Deployed
            </span>
          )}
          <span
            className="text-xs max-w-[100px] truncate"
            style={{ color: 'var(--text-secondary)' }}
            title={deployment.url}
          >
            {displayUrl}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(deployment.url);
              toast.success('URL copied');
            }}
            className="p-0.5 rounded transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            title="Copy URL"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
          <a
            href={deployment.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="p-0.5 rounded transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            title="Open in new tab"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      );
    }

    return null;
  };

  const getStatusBadge = (status: string, deployment?: ChangeSetDeployment | null, isProduction?: boolean) => {
    // IMPORTANT: Check for 'reverted' status FIRST - it takes precedence over deployment status
    // A reverted changeset should always show as reverted, even if it was previously deployed
    if (status === 'reverted') {
      return (
        <span className="px-2 py-0.5 rounded text-xs bg-accent-orange/20 text-accent-orange border border-accent-orange/30">
          Reverted
        </span>
      );
    }

    // If we have deployment info, use that instead of the status for visual display
    const deploymentCapsule = getDeploymentCapsule(deployment, isProduction);
    if (deploymentCapsule) {
      return deploymentCapsule;
    }

    switch (status) {
      case 'published':
        return (
          <span className="px-2 py-0.5 rounded text-xs bg-accent-blue/20 text-accent-blue border border-accent-blue/30">
            Deployed
          </span>
        );
      case 'committed':
        return (
          <span className="px-2 py-0.5 rounded text-xs bg-accent-purple/20 text-accent-purple border border-accent-purple/30">
            Committed
          </span>
        );
      case 'verified':
        return (
          <span className="px-2 py-0.5 rounded text-xs bg-accent-blue/20 text-accent-blue border border-accent-blue/30">
            Verified
          </span>
        );
      case 'applied':
      default:
        return (
          <span className="px-2 py-0.5 rounded text-xs" style={{ background: neutralTone.bg, color: 'var(--text-secondary)', border: `1px solid ${neutralTone.border}` }}>
            Applied
          </span>
        );
    }
  };

  const getDisplayIdBadge = (displayId?: string) => {
    // Always show CS-### badge - if no displayId exists (shouldn't happen after migration), show CS-???
    return (
      <span className="px-2 py-0.5 rounded text-xs bg-accent-blue/20 text-accent-blue border border-accent-blue/30 font-mono">
        {displayId || 'CS-???'}
      </span>
    );
  };

  const getCommitBadge = (commitSha?: unknown, status?: string, alsoInChangesets?: ChangeSetAlsoIn[]) => {
    const shortSha = shortCommitSha(commitSha);
    // Only show commit hash badge for committed or published status
    if (!shortSha || (status !== 'committed' && status !== 'published')) return null;

    // Build tooltip text - include "Also in:" if there are other changesets with same commit
    const alsoInText = alsoInChangesets && alsoInChangesets.length > 0
      ? `\nAlso in: ${alsoInChangesets.map(cs => cs.displayId || cs.id.substring(0, 7)).join(', ')}`
      : '';
    const tooltipText = `Git commit: ${shortSha}${alsoInText}`;

    return (
      <span
        className="px-2 py-0.5 rounded text-xs font-mono"
        style={{ background: 'var(--review-code-bg)', color: 'var(--text-primary)', border: '1px solid var(--review-shell-border)' }}
        title={tooltipText}
      >
        {shortSha}
        {alsoInChangesets && alsoInChangesets.length > 0 && (
          <span className="ml-1 text-accent-yellow" title={`Also in: ${alsoInChangesets.map(cs => cs.displayId || cs.id.substring(0, 7)).join(', ')}`}>*</span>
        )}
      </span>
    );
  };

  const getVerificationBadge = (status: VerificationStatus, label: string) => {
    if (status === 'not_run') {
      return (
        <span className="px-2 py-0.5 rounded text-xs" style={{ background: neutralTone.bg, color: 'var(--text-secondary)', border: `1px solid ${neutralTone.border}` }}>
          {label}
        </span>
      );
    }
    if (status === 'pass') {
      return (
        <span className="px-2 py-0.5 rounded text-xs bg-accent-green/20 text-accent-green border border-accent-green/30 flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {label}
        </span>
      );
    }
    return (
      <span className="px-2 py-0.5 rounded text-xs bg-accent-red/20 text-accent-red border border-accent-red/30 flex items-center gap-1">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
        {label}
      </span>
    );
  };

  const hasAnyChecksAvailable = Boolean(availableChecks && ((availableChecks.checks?.length || 0) > 0 || availableChecks.hasChecks || availableChecks.lint || availableChecks.unit || availableChecks.e2e));

  const getInlineVerificationBadges = (verification?: ChangeSetIndex['verification']) => {
    if (!verification || !availableChecks) return null;

    const badges: React.ReactNode[] = [];

    if (availableChecks.lint) {
      const status = verification.lint || 'not_run';
      const icon = status === 'pass' ? '\u2713' : status === 'fail' ? '\u2717' : '-';
      const color = status === 'pass' ? 'text-accent-green' : status === 'fail' ? 'text-accent-red' : 'text-[var(--text-tertiary)]';
      badges.push(
        <span key="lint" className={`text-xs ${color}`} title={`Lint: ${status}`}>
          Lint {icon}
        </span>
      );
    }

    if (availableChecks.unit) {
      const status = verification.unit || 'not_run';
      const icon = status === 'pass' ? '\u2713' : status === 'fail' ? '\u2717' : '-';
      const color = status === 'pass' ? 'text-accent-green' : status === 'fail' ? 'text-accent-red' : 'text-[var(--text-tertiary)]';
      badges.push(
        <span key="unit" className={`text-xs ${color}`} title={`Unit: ${status}`}>
          Unit {icon}
        </span>
      );
    }

    if (availableChecks.e2e) {
      const status = verification.e2e || 'not_run';
      const icon = status === 'pass' ? '\u2713' : status === 'fail' ? '\u2717' : 'N/A';
      const color = status === 'pass' ? 'text-accent-green' : status === 'fail' ? 'text-accent-red' : 'text-[var(--text-tertiary)]';
      badges.push(
        <span key="e2e" className={`text-xs ${color}`} title={`E2E: ${status}`}>
          E2E {icon}
        </span>
      );
    }

    return badges.length > 0 ? (
      <div className="flex items-center gap-2">{badges}</div>
    ) : null;
  };

  const getRiskFlagChips = (riskFlags?: ChangeSetRiskFlags) => {
    if (!riskFlags) return null;

    const chips: React.ReactNode[] = [];

    if (riskFlags.dependencyChanges) {
      chips.push(
        <span
          key="deps"
          className="px-2 py-0.5 rounded text-xs bg-accent-orange/20 text-accent-orange border border-accent-orange/30"
          title="Package dependencies modified"
        >
          Dependencies
        </span>
      );
    }

    if (riskFlags.envChanges) {
      chips.push(
        <span
          key="env"
          className="px-2 py-0.5 rounded text-xs bg-accent-orange/20 text-accent-orange border border-accent-orange/30"
          title="Environment or config files modified"
        >
          Env/Config
        </span>
      );
    }

    if (riskFlags.buildConfigChanges) {
      chips.push(
        <span
          key="build"
          className="px-2 py-0.5 rounded text-xs bg-accent-orange/20 text-accent-orange border border-accent-orange/30"
          title="Build configuration modified"
        >
          Build Config
        </span>
      );
    }

    if (riskFlags.largeBlastRadius) {
      const totalChanges = riskFlags.totalAdditions + riskFlags.totalDeletions;
      const label = riskFlags.fileCount >= 5
        ? `${riskFlags.fileCount} files`
        : `+${riskFlags.totalAdditions}/-${riskFlags.totalDeletions} lines`;
      chips.push(
        <span
          key="large"
          className="px-2 py-0.5 rounded text-xs bg-accent-yellow/20 text-accent-yellow border border-accent-yellow/30"
          title={`Large change: ${riskFlags.fileCount} files, ${totalChanges} lines modified`}
        >
          {label}
        </span>
      );
    }

    return chips.length > 0 ? chips : null;
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--review-shell-bg)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-header-bg)' }}>
        <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Change Sets</h3>
        <div className="flex items-center gap-2">
          {/* Live site status */}
          {lastDeploymentUrl && (
            <a
              href={lastDeploymentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs flex items-center gap-1.5 transition-colors"
              style={{ color: 'var(--text-secondary)' }}
              title={lastDeploymentUrl}
            >
              <span className="w-1.5 h-1.5 bg-accent-green rounded-full" />
              <span>Live: {lastDeploymentAt ? formatRelativeTime(lastDeploymentAt) : 'deployed'}</span>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
          <button
            onClick={() => setIsPublishPanelOpen(true)}
            className="flex items-center gap-1"
            style={getReviewActionButtonStyle({ tone: 'purple', active: true })}
            title="Publish Project"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Publish
          </button>
          <button
            onClick={loadChangesets}
            disabled={isLoading}
            style={getReviewActionButtonStyle({ tone: 'neutral', disabled: isLoading })}
            title="Refresh"
          >
            <svg
              className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Production Banner */}
      {productionStatus?.hasProduction && productionStatus.deployment && (
        <div
          className="mx-3 mt-3 mb-0 p-2.5"
          style={{
            background: 'linear-gradient(90deg, color-mix(in srgb, var(--chip-success-bg) 76%, var(--review-card-bg) 24%) 0%, var(--review-card-bg) 100%)',
            borderRadius: 16,
            border: '1px solid var(--chip-success-border)',
            boxShadow: 'var(--review-panel-shadow)',
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {/* Production indicator */}
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="w-2 h-2 bg-accent-green rounded-full animate-pulse" />
                <span className="text-xs font-medium text-accent-green">Production</span>
              </div>

              {/* Changeset reference */}
              {productionStatus.deployment.changeset && (
                <button
                  onClick={() => {
                    const csId = productionStatus.deployment?.changeset?.id;
                    if (csId) handleToggleExpand(csId);
                  }}
                  className="px-1.5 py-0.5 bg-accent-blue/20 text-accent-blue border border-accent-blue/30 rounded text-[10px] font-mono hover:bg-accent-blue/30 transition-colors"
                >
                  {productionStatus.deployment.changeset.displayId || 'CS-???'}
                </button>
              )}

              {/* Commit hash */}
              {productionStatus.deployment.commitHash && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono flex-shrink-0" style={{ background: 'var(--review-code-bg)', color: 'var(--text-secondary)', border: '1px solid var(--review-shell-border)' }}>
                  {productionStatus.deployment.commitHash.substring(0, 7)}
                </span>
              )}

              {/* URL pill - truncated */}
              <span
                className="text-xs truncate max-w-[150px]"
                style={{ color: 'var(--text-primary)' }}
                title={productionStatus.deployment.url}
              >
                {(() => {
                  try {
                    const url = new URL(productionStatus.deployment.url);
                    return url.hostname + (url.pathname !== '/' ? url.pathname : '');
                  } catch {
                    return productionStatus.deployment.url;
                  }
                })()}
              </span>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(productionStatus.deployment!.url);
                  toast.success('URL copied');
                }}
                style={getReviewActionButtonStyle({ tone: 'neutral' })}
                title="Copy URL"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
              <button
                onClick={() => window.open(productionStatus.deployment!.url, '_blank')}
                style={getReviewActionButtonStyle({ tone: 'neutral' })}
                title="Open in new tab"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filter / Sort Bar */}
      {changesets.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-bg)' }}>
          <div className="flex items-center gap-1">
            {(['all', 'reviewed', 'unreviewed', 'high-risk'] as const).map((mode) => {
              const labels: Record<typeof mode, string> = { all: 'All', reviewed: 'Reviewed', unreviewed: 'Unreviewed', 'high-risk': 'High Risk' };
              const count = mode === 'all' ? changesets.length
                : mode === 'reviewed' ? changesets.filter(cs => cs.reviewStatus === 'reviewed').length
                : mode === 'unreviewed' ? changesets.filter(cs => !cs.reviewStatus || cs.reviewStatus === 'none').length
                : changesets.filter(cs => cs.reviewRiskLevel === 'high' || cs.reviewRiskLevel === 'critical').length;
              return (
                <button
                  key={mode}
                  onClick={() => setFilterMode(mode)}
                  className="px-2 py-0.5 rounded text-xs font-medium transition-colors"
                  style={{
                    background: filterMode === mode ? 'var(--review-segment-active-bg)' : 'transparent',
                    color: filterMode === mode ? 'var(--accent-purple)' : 'var(--text-tertiary)',
                    border: `1px solid ${filterMode === mode ? 'rgba(var(--accent-purple-rgb), 0.24)' : 'transparent'}`,
                  }}
                >
                  {labels[mode]}{count > 0 ? ` (${count})` : ''}
                </button>
              );
            })}
          </div>
          <div className="ml-auto">
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="text-xs rounded px-1.5 py-0.5 focus:outline-none"
              style={{ background: 'var(--review-code-bg)', color: 'var(--text-secondary)', border: '1px solid var(--review-shell-border)' }}
            >
              <option value="newest">Newest</option>
              <option value="risk">Risk Level</option>
            </select>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3" style={{ background: 'var(--review-panel-bg)' }}>
        {isLoading && changesets.length === 0 ? (
          <div className="text-center text-sm py-8" style={{ color: 'var(--text-secondary)' }}>
            <svg className="w-5 h-5 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Loading changesets...
          </div>
        ) : loadError ? (
          <div className="text-center text-accent-red text-sm py-4">
            <p className="mb-2">{loadError}</p>
            <button
              onClick={loadChangesets}
              className="text-accent-blue hover:text-accent-blue underline"
            >
              Retry
            </button>
          </div>
        ) : changesets.length === 0 ? (
          <div className="text-center text-sm py-8" style={{ color: 'var(--text-secondary)' }}>
            <svg className="w-8 h-8 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            No changesets yet.
            <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              Changesets will appear here when Claude modifies files.
            </p>
          </div>
        ) : filteredChangesets.length === 0 ? (
          <div className="text-center text-sm py-6" style={{ color: 'var(--text-tertiary)' }}>
            No changesets match the current filter.
          </div>
        ) : (
          <div className="space-y-2">
            {filteredChangesets.map((changeset) => (
              <div
                key={changeset.id}
                className="overflow-hidden"
                style={{
                  background: expandedId === changeset.id ? 'var(--review-card-bg)' : 'var(--review-panel-bg)',
                  borderRadius: 16,
                  border: '1px solid var(--review-shell-border)',
                  boxShadow: 'var(--review-panel-shadow)',
                }}
              >
                {/* Changeset Header */}
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer"
                  style={{ background: expandedId === changeset.id ? 'var(--review-card-hover)' : 'transparent' }}
                  onClick={() => handleToggleExpand(changeset.id)}
                >
                  <svg
                    className={`w-4 h-4 flex-shrink-0 transition-transform duration-200 ${
                      expandedId === changeset.id ? 'rotate-90' : ''
                    }`}
                    style={{ color: 'var(--text-secondary)' }}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>

                  <span className="text-accent-blue flex-shrink-0" title={changeset.source}>
                    {getSourceIcon(changeset.source)}
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                      {changeset.commitMessage || changeset.title}
                    </div>
                    {changeset.summary && (
                      <div className="text-xs italic truncate max-w-[200px]" style={{ color: 'var(--text-secondary)' }} title={changeset.summary}>
                        {changeset.summary}
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      <span>{changeset.fileCount} file{changeset.fileCount !== 1 ? 's' : ''}</span>
                      <span>{formatRelativeTime(changeset.createdAt)}</span>
                      {getInlineVerificationBadges(changeset.verification)}
                    </div>
                  </div>

                  <div className="flex-shrink-0 flex items-center gap-1">
                    {getDisplayIdBadge(changeset.displayId)}
                    {getCommitBadge(
                      changeset.commitSha,
                      changeset.status,
                      // Find other changesets with same commit hash (for "Also in" tooltip)
                      changeset.commitSha
                        ? changesets
                            .filter(cs => (
                              normalizeCommitSha(cs.commitSha) === normalizeCommitSha(changeset.commitSha)
                              && cs.id !== changeset.id
                            ))
                            .map(cs => ({ id: cs.id, displayId: cs.displayId }))
                        : undefined
                    )}
                    {/* Review risk level badge */}
                    {changeset.reviewStatus === 'reviewed' && changeset.reviewRiskLevel && (
                      <span className={`px-2 py-0.5 rounded text-xs border ${
                        changeset.reviewRiskLevel === 'low' ? 'bg-accent-green/20 text-accent-green border-accent-green/30' :
                        changeset.reviewRiskLevel === 'medium' ? 'bg-accent-yellow/20 text-accent-yellow border-accent-yellow/30' :
                        changeset.reviewRiskLevel === 'high' ? 'bg-accent-red/20 text-accent-red border-accent-red/30' :
                        'bg-accent-red/30 text-accent-red border-accent-red/40'
                      }`}>
                        {changeset.reviewRiskLevel === 'low' ? 'Low Risk' :
                         changeset.reviewRiskLevel === 'medium' ? 'Med Risk' :
                         changeset.reviewRiskLevel === 'high' ? 'High Risk' :
                         'Critical'}
                      </span>
                    )}
                    {changeset.reviewStatus === 'queued' && (
                      <span className="px-2 py-0.5 rounded text-xs bg-indigo-600/20 text-indigo-300 border border-indigo-600/30 flex items-center gap-1">
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Queued
                      </span>
                    )}
                    {changeset.reviewStatus === 'reviewing' && (
                      <span className="px-2 py-0.5 rounded text-xs bg-accent-blue/20 text-accent-blue border border-accent-blue/30 flex items-center gap-1">
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Reviewing
                      </span>
                    )}
                    {changeset.reviewStatus === 'failed' && (
                      <span className="px-2 py-0.5 rounded text-xs bg-accent-red/20 text-accent-red border border-accent-red/30">
                        Review Failed
                      </span>
                    )}
                    {getStatusBadge(changeset.status, changeset.deployment, changeset.isProduction)}
                  </div>
                </div>

                {/* Expanded Content */}
                {expandedId === changeset.id && (
                  <div style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                    {isLoadingDetail ? (
                      <div className="text-center text-sm py-4" style={{ color: 'var(--text-secondary)' }}>
                        <svg className="w-4 h-4 animate-spin mx-auto mb-1" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Loading details...
                      </div>
                    ) : expandedChangeset ? (
                      <div className="p-3 space-y-3">
                        {/* Summary Section */}
                        <div className="space-y-1">
                          {editingSummaryId === expandedChangeset.id ? (
                            <div className="space-y-2">
                              <textarea
                                value={editingSummaryText}
                                onChange={(e) => setEditingSummaryText(e.target.value)}
                                className="w-full px-2 py-1 rounded text-sm focus:outline-none"
                                style={{
                                  background: 'var(--review-code-bg)',
                                  border: '1px solid var(--review-shell-border-strong)',
                                  color: 'var(--text-primary)',
                                }}
                                rows={2}
                                placeholder="Describe what this changeset does..."
                                autoFocus
                              />
                              <div className="flex gap-2">
                                <button
                                  onClick={handleSaveSummary}
                                  disabled={isSavingSummary}
                                  style={getReviewActionButtonStyle({ tone: 'blue', active: true, disabled: isSavingSummary })}
                                >
                                  {isSavingSummary ? 'Saving...' : 'Save'}
                                </button>
                                <button
                                  onClick={handleCancelEditSummary}
                                  disabled={isSavingSummary}
                                  style={getReviewActionButtonStyle({ tone: 'neutral', disabled: isSavingSummary })}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-2">
                              <div className="flex-1 text-sm italic line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                                {expandedChangeset.summary || (
                                  <span style={{ color: 'var(--text-tertiary)' }}>No summary. Click to add one.</span>
                                )}
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleEditSummary(changeset);
                                }}
                                className="flex-shrink-0 p-1 rounded"
                                style={{ color: 'var(--text-tertiary)' }}
                                title="Edit summary"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                </svg>
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Risk Flags */}
                        {getRiskFlagChips(expandedChangeset.riskFlags) && (
                          <div className="flex flex-wrap gap-2">
                            {getRiskFlagChips(expandedChangeset.riskFlags)}
                          </div>
                        )}

                        {/* Preview Status */}
                        <div
                          className="flex items-center justify-between py-2 px-3 rounded-lg"
                          style={{
                            background: 'var(--review-card-bg)',
                            border: '1px solid var(--review-shell-border)',
                            boxShadow: 'var(--review-panel-shadow)',
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Preview:</span>
                            {isLoadingPreview ? (
                              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Loading...</span>
                            ) : previewStatus?.running ? (
                              <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-accent-green animate-pulse" title="Running"></span>
                                <span className="text-xs text-accent-green">Running</span>
                                {previewStatus.url && (
                                  <a
                                    href={previewStatus.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-accent-blue hover:text-accent-blue hover:underline ml-1"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {previewStatus.url}
                                  </a>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-content-tertiary" title="Stopped"></span>
                                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Stopped</span>
                              </div>
                            )}
                          </div>
                          {previewStatus?.running ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenPreview();
                              }}
                              className="flex items-center gap-1"
                              style={getReviewActionButtonStyle({ tone: 'blue', active: true })}
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                              </svg>
                              Open Preview
                            </button>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStartPreview();
                              }}
                              className="flex items-center gap-1"
                              style={getReviewActionButtonStyle({ tone: 'green', active: true })}
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              Start Preview
                            </button>
                          )}
                        </div>

                        {/* File List - deduplicated by path */}
                        {(() => {
                          // Deduplicate files by path, merging to show full diff:
                          // - Keep earliest 'before' (original state)
                          // - Keep latest 'after' (final state)
                          const fileMap = new Map<string, typeof expandedChangeset.files[0]>();
                          expandedChangeset.files.forEach(file => {
                            const existing = fileMap.get(file.path);
                            if (existing) {
                              // Merge: keep first 'before', update 'after' to latest
                              fileMap.set(file.path, {
                                ...file,
                                before: existing.before, // Keep original 'before'
                                after: file.after,       // Use latest 'after'
                              });
                            } else {
                              fileMap.set(file.path, file);
                            }
                          });
                          const uniqueFiles = Array.from(fileMap.values());

                          return (
                            <>
                              <div className="space-y-1 text-xs">
                                <span style={{ color: 'var(--text-secondary)' }}>Files changed:</span>
                                <ul className="ml-2" style={{ color: 'var(--text-primary)' }}>
                                  {uniqueFiles.map((file, idx) => (
                                    <li key={idx} className="flex items-center gap-1">
                                      <span className={file.before === null ? 'text-accent-green' : file.after === null ? 'text-accent-red' : 'text-accent-yellow'}>
                                        {file.before === null ? '+' : file.after === null ? '-' : '~'}
                                      </span>
                                      <span className="truncate">{file.path}</span>
                                    </li>
                                  ))}
                                </ul>
                              </div>

                              {/* Diff Views */}
                              <div className="space-y-2">
                                {uniqueFiles.map((file, idx) => (
                                  <DiffViewer
                                    key={idx}
                                    filePath={file.path}
                                    beforeContent={file.before}
                                    afterContent={file.after || ''}
                                    isNewFile={file.before === null}
                                    language={file.language}
                                    stats={{
                                      additions: file.after ? (file.after.match(/\n/g) || []).length + 1 : 0,
                                      deletions: file.before ? (file.before.match(/\n/g) || []).length + 1 : 0,
                                    }}
                                    defaultCollapsed={uniqueFiles.length > 1}
                                  />
                                ))}
                              </div>
                            </>
                          );
                        })()}

                        {/* AI Review Section */}
                        <div
                          className="rounded-lg p-3 space-y-2"
                          style={{
                            background: 'var(--review-card-bg)',
                            border: '1px solid var(--review-shell-border)',
                            boxShadow: 'var(--review-panel-shadow)',
                          }}
                        >
                          <div className="flex items-center justify-between">
                            <h4 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>AI Review</h4>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRunReview(expandedChangeset.id);
                              }}
                              disabled={
                                isRunningReview === expandedChangeset.id
                                || expandedChangeset.reviewStatus === 'queued'
                                || expandedChangeset.reviewStatus === 'reviewing'
                              }
                              className="flex items-center gap-1.5"
                              style={getReviewActionButtonStyle({
                                tone: expandedChangeset.reviewStatus === 'reviewed' ? 'blue' : 'purple',
                                active: true,
                                disabled:
                                  isRunningReview === expandedChangeset.id
                                  || expandedChangeset.reviewStatus === 'queued'
                                  || expandedChangeset.reviewStatus === 'reviewing',
                              })}
                            >
                              {isRunningReview === expandedChangeset.id ? (
                                <>
                                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                  </svg>
                                  Queueing...
                                </>
                              ) : expandedChangeset.reviewStatus === 'queued' ? (
                                <>
                                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                  </svg>
                                  Queued...
                                </>
                              ) : expandedChangeset.reviewStatus === 'reviewing' ? (
                                <>
                                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                  </svg>
                                  Reviewing...
                                </>
                              ) : expandedChangeset.reviewStatus === 'reviewed' ? (
                                <>
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                  </svg>
                                  Re-review
                                </>
                              ) : (
                                <>
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                  </svg>
                                  Review
                                </>
                              )}
                            </button>
                          </div>

                          {/* Review result display */}
                          {expandedChangeset.reviewStatus === 'reviewed' && expandedChangeset.reviewData && (
                            <div className="space-y-2">
                              {/* Risk level + summary */}
                              <div className={`p-2 rounded border ${
                                expandedChangeset.reviewData.riskLevel === 'low' ? 'bg-accent-green/10 border-accent-green/20' :
                                expandedChangeset.reviewData.riskLevel === 'medium' ? 'bg-accent-yellow/10 border-accent-yellow/20' :
                                expandedChangeset.reviewData.riskLevel === 'high' ? 'bg-accent-red/10 border-accent-red/20' :
                                'bg-accent-red/20 border-accent-red/30'
                              }`}>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className={`w-2 h-2 rounded-full ${
                                    expandedChangeset.reviewData.riskLevel === 'low' ? 'bg-accent-green' :
                                    expandedChangeset.reviewData.riskLevel === 'medium' ? 'bg-accent-yellow' :
                                    expandedChangeset.reviewData.riskLevel === 'high' ? 'bg-accent-red' :
                                    'bg-accent-red'
                                  }`} />
                                  <span className="text-xs font-medium uppercase" style={{ color: 'var(--text-primary)' }}>
                                    {expandedChangeset.reviewData.riskLevel} risk
                                  </span>
                                  <span className="text-xs ml-auto" style={{ color: 'var(--text-tertiary)' }}>
                                    {expandedChangeset.reviewData.stats.estimatedComplexity}
                                  </span>
                                </div>
                                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{expandedChangeset.reviewData.summary}</p>
                              </div>

                              {/* Expand/collapse toggle for full review */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedReview(expandedReview === expandedChangeset.id ? null : expandedChangeset.id);
                                }}
                                className="flex items-center gap-1.5 text-xs"
                                style={{ color: 'var(--text-secondary)' }}
                              >
                                <svg className={`w-3 h-3 transition-transform ${expandedReview === expandedChangeset.id ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                                {expandedChangeset.reviewData.changeGroups.length} change group{expandedChangeset.reviewData.changeGroups.length !== 1 ? 's' : ''} &middot;
                                {expandedChangeset.reviewData.recommendations.length} recommendation{expandedChangeset.reviewData.recommendations.length !== 1 ? 's' : ''}
                              </button>

                              {/* Full review details */}
                              {expandedReview === expandedChangeset.id && (
                                <div className="space-y-3">
                                  {/* Change Groups */}
                                  {expandedChangeset.reviewData.changeGroups.map((group, idx) => (
                                    <div
                                      key={idx}
                                      className="rounded p-2"
                                      style={{ background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border)' }}
                                    >
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className={`w-1.5 h-1.5 rounded-full ${
                                          group.risk === 'low' ? 'bg-accent-green' :
                                          group.risk === 'medium' ? 'bg-accent-yellow' :
                                          group.risk === 'high' ? 'bg-accent-red' :
                                          'bg-accent-red'
                                        }`} />
                                        <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{group.label}</span>
                                      </div>
                                      <p className="text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{group.description}</p>
                                      <div className="flex flex-wrap gap-1">
                                        {group.files.map((file, fIdx) => (
                                          <span
                                            key={fIdx}
                                            className="text-xs px-1.5 py-0.5 rounded font-mono"
                                            style={{ color: 'var(--text-tertiary)', background: 'var(--review-panel-bg)' }}
                                          >
                                            {file.path.split('/').pop()}
                                            <span className="text-accent-green ml-1">+{file.additions}</span>
                                            <span className="text-accent-red">-{file.deletions}</span>
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  ))}

                                  {/* Recommendations */}
                                  {expandedChangeset.reviewData.recommendations.length > 0 && (
                                    <div className="space-y-1.5">
                                      <h5 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Recommendations</h5>
                                      {expandedChangeset.reviewData.recommendations.map((rec, idx) => (
                                        <div key={idx} className={`text-xs p-2 rounded border ${
                                          rec.type === 'issue' ? 'bg-accent-red/10 border-accent-red/20 text-accent-red' :
                                          rec.type === 'suggestion' ? 'bg-accent-blue/10 border-accent-blue/20 text-accent-blue' :
                                          'bg-accent-green/10 border-accent-green/20 text-accent-green'
                                        }`}>
                                          <div className="flex items-center gap-1.5 mb-0.5">
                                            <span className="font-medium">{rec.type === 'issue' ? 'Issue' : rec.type === 'suggestion' ? 'Suggestion' : 'Praise'}:</span>
                                            <span style={{ color: 'var(--text-primary)' }}>{rec.title}</span>
                                          </div>
                                          <p style={{ color: 'var(--text-secondary)' }}>{rec.description}</p>
                                          {rec.file && (
                                            <span className="font-mono mt-0.5 inline-block" style={{ color: 'var(--text-tertiary)' }}>{rec.file}{rec.line ? `:${rec.line}` : ''}</span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {/* Review metadata */}
                                  <div className="text-xs flex items-center gap-3" style={{ color: 'var(--text-tertiary)' }}>
                                    <span>Reviewed by {expandedChangeset.reviewedBy}</span>
                                    <span>{expandedChangeset.reviewData.tokensUsed.input + expandedChangeset.reviewData.tokensUsed.output} tokens</span>
                                    <span>
                                      {expandedChangeset.reviewData.estimatedCost != null
                                        ? `${expandedChangeset.reviewData.costIsApproximate ? 'Approx cost' : 'Estimated cost'} $${expandedChangeset.reviewData.estimatedCost.toFixed(4)}`
                                        : 'Estimate unavailable'}
                                    </span>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Open Full Review button */}
                          {expandedChangeset.reviewStatus === 'reviewed' && onOpenReview && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenReview(expandedChangeset.id, expandedChangeset.title);
                              }}
                              className="w-full flex items-center justify-center gap-1.5"
                              style={{ ...getReviewActionButtonStyle({ tone: 'neutral' }), width: '100%' }}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                              Open Full Review
                            </button>
                          )}

                          {expandedChangeset.reviewStatus === 'failed' && (
                            <div className="text-xs text-accent-red p-2 bg-accent-red/10 rounded border border-accent-red/20">
                              Review failed. Click "Review" to retry.
                            </div>
                          )}

                          {(expandedChangeset.reviewStatus === 'queued' || expandedChangeset.reviewStatus === 'reviewing') && (
                            <div className="text-xs text-accent-blue p-2 bg-accent-blue/10 rounded border border-accent-blue/20">
                              {expandedChangeset.reviewStatus === 'queued'
                                ? 'Review queued. Analysis will start shortly.'
                                : 'Review in progress...'}
                            </div>
                          )}

                          {(!expandedChangeset.reviewStatus || expandedChangeset.reviewStatus === 'none') && expandedChangeset.files && expandedChangeset.files.length > 0 && (
                            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                              Click "Review" to get an AI analysis of these changes.
                            </div>
                          )}

                          {expandedChangeset.files && expandedChangeset.files.length === 0 && (
                            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                              No file contents available for review.
                            </div>
                          )}
                        </div>

                        {/* Verification Section */}
                        {hasAnyChecksAvailable && (() => {
                          const isVerifiedOrBeyond = ['verified', 'committed', 'published'].includes(expandedChangeset.status);
                          const verification = expandedChangeset.verification;

                          return (
                            <div className="pt-2 space-y-2" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                              <div className="flex items-center justify-between">
                                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Verification</span>
                              </div>

                              {/* Verification Summary Row - prominent for verified changesets */}
                              {isVerifiedOrBeyond && verification?.lastRunAt && (
                                <div className="flex items-center gap-2 text-xs">
                                  <span className="text-content">
                                    {availableChecks?.lint && (
                                      <span className={verification.lint === 'pass' ? 'text-accent-green' : verification.lint === 'fail' ? 'text-accent-red' : 'text-[var(--text-tertiary)]'}>
                                        Lint {verification.lint === 'pass' ? 'PASS' : verification.lint === 'fail' ? 'FAIL' : 'N/A'}
                                      </span>
                                    )}
                                    {availableChecks?.lint && availableChecks?.unit && ' · '}
                                    {availableChecks?.unit && (
                                      <span className={verification.unit === 'pass' ? 'text-accent-green' : verification.unit === 'fail' ? 'text-accent-red' : 'text-[var(--text-tertiary)]'}>
                                        Unit {verification.unit === 'pass' ? 'PASS' : verification.unit === 'fail' ? 'FAIL' : 'N/A'}
                                      </span>
                                    )}
                                    {availableChecks?.unit && availableChecks?.e2e && ' · '}
                                    {availableChecks?.e2e && (
                                      <span className={verification.e2e === 'pass' ? 'text-accent-green' : verification.e2e === 'fail' ? 'text-accent-red' : 'text-[var(--text-tertiary)]'}>
                                        E2E {verification.e2e === 'pass' ? 'PASS' : verification.e2e === 'fail' ? 'FAIL' : 'N/A'}
                                      </span>
                                    )}
                                  </span>
                                  <span style={{ color: 'var(--text-tertiary)' }}>
                                    · Verified {formatRelativeTime(verification.lastRunAt)}
                                  </span>
                                </div>
                              )}

                              {/* Verification Badges - only show when not yet verified */}
                              {!isVerifiedOrBeyond && (
                                <div className="flex flex-wrap gap-2">
                                  {availableChecks?.lint && (
                                    <span className={verifyConfig.lint ? '' : 'opacity-40'}>
                                      {getVerificationBadge(verification?.lint || 'not_run', 'Lint')}
                                    </span>
                                  )}
                                  {availableChecks?.unit && (
                                    <span className={verifyConfig.unit ? '' : 'opacity-40'}>
                                      {getVerificationBadge(verification?.unit || 'not_run', 'Unit')}
                                    </span>
                                  )}
                                  {availableChecks?.e2e && (
                                    <span className={verifyConfig.e2e ? '' : 'opacity-40'}>
                                      {getVerificationBadge(verification?.e2e || 'not_run', 'E2E')}
                                    </span>
                                  )}
                                </div>
                              )}

                              {/* Verify button - prominent for applied, secondary for verified/committed/published */}
                              {isVerifiedOrBeyond ? (
                                // Secondary "Re-verify" button for already verified changesets
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRunVerification(expandedChangeset.id);
                                  }}
                                  disabled={isRunningVerification === expandedChangeset.id}
                                  className="flex items-center gap-1.5"
                                  style={getReviewActionButtonStyle({ tone: 'neutral', disabled: isRunningVerification === expandedChangeset.id })}
                                >
                                  {isRunningVerification === expandedChangeset.id ? (
                                    <>
                                      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                      </svg>
                                      Running...
                                    </>
                                  ) : (
                                    <>
                                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                      </svg>
                                      Re-verify
                                    </>
                                  )}
                                </button>
                              ) : (
                                // Primary "Verify" button for applied changesets
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRunVerification(expandedChangeset.id);
                                  }}
                                  disabled={isRunningVerification === expandedChangeset.id}
                                  className="w-full flex items-center justify-center gap-2"
                                  style={{ ...getReviewActionButtonStyle({ tone: 'purple', active: true, disabled: isRunningVerification === expandedChangeset.id }), width: '100%' }}
                                >
                                  {isRunningVerification === expandedChangeset.id ? (
                                    <>
                                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                      </svg>
                                      Verifying...
                                    </>
                                  ) : (
                                    <>
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                      </svg>
                                      Verify
                                    </>
                                  )}
                                </button>
                              )}

                              {/* Per-check enable/disable toggles */}
                              {hasAnyChecksAvailable && (
                                <div className="flex items-center gap-3 text-xs">
                                  <span style={{ color: 'var(--text-tertiary)' }}>Checks:</span>
                                  {availableChecks?.lint && (
                                    <label className="flex items-center gap-1 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                                      <input
                                        type="checkbox"
                                        checked={verifyConfig.lint}
                                        onChange={() => handleToggleVerifyCheck('lint')}
                                        className="rounded w-3.5 h-3.5"
                                        style={{ accentColor: 'var(--accent-purple)' }}
                                      />
                                      <span style={{ color: verifyConfig.lint ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>Lint</span>
                                    </label>
                                  )}
                                  {availableChecks?.unit && (
                                    <label className="flex items-center gap-1 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                                      <input
                                        type="checkbox"
                                        checked={verifyConfig.unit}
                                        onChange={() => handleToggleVerifyCheck('unit')}
                                        className="rounded w-3.5 h-3.5"
                                        style={{ accentColor: 'var(--accent-purple)' }}
                                      />
                                      <span style={{ color: verifyConfig.unit ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>Unit Tests</span>
                                    </label>
                                  )}
                                  {availableChecks?.e2e && (
                                    <label className="flex items-center gap-1 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                                      <input
                                        type="checkbox"
                                        checked={verifyConfig.e2e}
                                        onChange={() => handleToggleVerifyCheck('e2e')}
                                        className="rounded w-3.5 h-3.5"
                                        style={{ accentColor: 'var(--accent-purple)' }}
                                      />
                                      <span style={{ color: verifyConfig.e2e ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>E2E Tests</span>
                                    </label>
                                  )}
                                </div>
                              )}

                              {/* Expandable Logs */}
                              {verification?.logs && Object.keys(verification.logs).length > 0 && (
                                <div className="space-y-2">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setExpandedLogs(expandedLogs === expandedChangeset.id ? null : expandedChangeset.id);
                                    }}
                                    className="flex items-center gap-1 text-xs"
                                    style={{ color: 'var(--text-secondary)' }}
                                  >
                                    <svg
                                      className={`w-3 h-3 transition-transform ${expandedLogs === expandedChangeset.id ? 'rotate-90' : ''}`}
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                    </svg>
                                    View Logs
                                  </button>

                                  {expandedLogs === expandedChangeset.id && (
                                    <div className="space-y-2">
                                      {Object.entries(verification.logs).map(([checkType, logs]) => (
                                        <div key={checkType} className="rounded p-2" style={{ background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border)' }}>
                                          <div className="text-xs mb-1 uppercase" style={{ color: 'var(--text-secondary)' }}>{checkType}</div>
                                          <pre className="text-xs whitespace-pre-wrap break-words font-mono max-h-48 overflow-y-auto" style={{ color: 'var(--text-primary)' }}>
                                            {logs}
                                          </pre>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* Deployment Section */}
                        {changeset.deployment && (
                          <div className="pt-2 space-y-2" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <svg className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                </svg>
                                <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Deployment</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {/* Status badge - show LIVE for production, Deployed for others */}
                                {changeset.deployment.status === 'succeeded' && changeset.isProduction && (
                                  <span className="px-2 py-0.5 rounded text-xs bg-accent-green text-content font-medium animate-pulse flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-content" />
                                    Live in Production
                                  </span>
                                )}
                                {changeset.deployment.status === 'succeeded' && !changeset.isProduction && (
                                  <span className="px-2 py-0.5 rounded text-xs bg-accent-blue/20 text-accent-blue border border-accent-blue/30">
                                    Deployed
                                  </span>
                                )}
                                {changeset.deployment.status === 'failed' && (
                                  <span className="px-2 py-0.5 rounded text-xs bg-accent-red/20 text-accent-red border border-accent-red/30">
                                    Failed
                                  </span>
                                )}
                                {(changeset.deployment.status === 'running' || changeset.deployment.status === 'queued') && (
                                  <span className="px-2 py-0.5 rounded text-xs bg-accent-yellow/20 text-accent-yellow border border-accent-yellow/30 flex items-center gap-1">
                                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Deploying
                                  </span>
                                )}
                                {/* Provider */}
                                <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'var(--review-chip-neutral-bg)', color: 'var(--text-secondary)', border: '1px solid var(--review-shell-border)' }}>
                                  Vercel
                                </span>
                              </div>
                            </div>

                            {/* URL with actions */}
                            {changeset.deployment.url && (
                              <div className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border)' }}>
                                <span className="flex-1 text-sm text-accent-blue font-mono truncate" title={changeset.deployment.url}>
                                  {changeset.deployment.url}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigator.clipboard.writeText(changeset.deployment!.url);
                                    toast.success('URL copied');
                                  }}
                                  className="p-1.5 rounded transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  title="Copy URL"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                  </svg>
                                </button>
                                <a
                                  href={changeset.deployment.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="p-1.5 rounded transition-colors"
                                  style={{ color: 'var(--text-secondary)' }}
                                  title="Open in new tab"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                  </svg>
                                </a>
                              </div>
                            )}

                            {/* Timing and provenance */}
                            <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                              {changeset.deployment.deployedAt && (
                                <span>Deployed {formatRelativeTime(changeset.deployment.deployedAt)}</span>
                              )}
                              {expandedChangeset?.displayId && (
                                <span>From {expandedChangeset.displayId}</span>
                              )}
                              {expandedChangeset?.commitSha && (
                                <span className="font-mono">{shortCommitSha(expandedChangeset.commitSha) || 'unknown'}</span>
                              )}
                            </div>

                            {/* Error message for failed deployments */}
                            {changeset.deployment.status === 'failed' && changeset.deployment.errorMessage && (
                              <div className="bg-accent-red/20 border border-accent-red/30 rounded p-2 text-xs text-accent-red">
                                {changeset.deployment.errorMessage}
                              </div>
                            )}

                            {/* Redeploy and Revert buttons */}
                            <div className="flex gap-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPublishChangesetId(changeset.id);
                                  setIsPublishPanelOpen(true);
                                }}
                                className="flex items-center gap-1.5"
                                style={getReviewActionButtonStyle({ tone: 'neutral' })}
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                Redeploy
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRevert(changeset);
                                }}
                                disabled={isReverting === changeset.id}
                                className="flex items-center gap-1.5"
                                style={getReviewActionButtonStyle({ tone: 'red', disabled: isReverting === changeset.id })}
                                title="Creates a new changeset that undoes these changes"
                              >
                                {isReverting === changeset.id ? (
                                  <>
                                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Reverting...
                                  </>
                                ) : (
                                  <>
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                                    </svg>
                                    Revert
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Never deployed indicator for committed changesets */}
                        {!changeset.deployment && changeset.status === 'committed' && (
                          <div className="pt-2 space-y-2" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                            <div className="flex items-center justify-between">
                              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Deployment</span>
                              <span className="px-2 py-0.5 rounded text-xs" style={{ background: 'var(--review-chip-neutral-bg)', color: 'var(--text-tertiary)', border: '1px solid var(--review-shell-border)' }}>
                                Never deployed
                              </span>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPublishChangesetId(changeset.id);
                                setIsPublishPanelOpen(true);
                              }}
                              className="w-full flex items-center justify-center gap-2"
                              style={{ ...getReviewActionButtonStyle({ tone: 'purple', active: true }), width: '100%' }}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                              </svg>
                              Deploy to Production
                            </button>
                          </div>
                        )}

                        {/* Action Buttons - show for applied and verified (not committed/published/reverted) */}
                        {['applied', 'verified'].includes(changeset.status) && (
                          <div className="pt-2" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                            {confirmRevert === changeset.id ? (
                              <div className="flex items-center justify-between gap-2 bg-accent-yellow/20 border border-accent-yellow rounded p-2">
                                <div className="text-xs text-accent-yellow">
                                  {changeset.commitSha ? (
                                    <>
                                      <p>This will create a new changeset that undoes these changes.</p>
                                      <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>Git history is preserved.</p>
                                    </>
                                  ) : (
                                    <p>Revert {changeset.fileCount} file{changeset.fileCount !== 1 ? 's' : ''} to their previous state?</p>
                                  )}
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => setConfirmRevert(null)}
                                    style={getReviewActionButtonStyle({ tone: 'neutral' })}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => handleRevert(changeset)}
                                    disabled={isReverting === changeset.id}
                                    style={getReviewActionButtonStyle({ tone: 'red', active: true, disabled: isReverting === changeset.id })}
                                  >
                                    Confirm
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex gap-2">
                                {/* Commit to Git Button - show for applied/verified if not already committed */}
                                {isGitRepo && !changeset.commitSha && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openCommitModal(changeset);
                                    }}
                                    disabled={isCommitting === changeset.id}
                                    className="flex-1 flex items-center justify-center gap-2"
                                    style={getReviewActionButtonStyle({ tone: 'blue', active: true, disabled: isCommitting === changeset.id })}
                                  >
                                    {isCommitting === changeset.id ? (
                                      <>
                                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                        Committing...
                                      </>
                                    ) : (
                                      <>
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                        </svg>
                                        Commit to Git
                                      </>
                                    )}
                                  </button>
                                )}
                                {/* Revert Button */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRevert(changeset);
                                  }}
                                  disabled={isReverting === changeset.id}
                                  className={`${changeset.commitSha ? 'flex-1' : ''} flex items-center justify-center gap-2`}
                                  style={getReviewActionButtonStyle({ tone: 'red', disabled: isReverting === changeset.id })}
                                  title={changeset.commitSha ? 'Creates a new changeset - does not modify git history' : 'Restore files to previous state'}
                                >
                                  {isReverting === changeset.id ? (
                                    <>
                                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                      </svg>
                                      Reverting...
                                    </>
                                  ) : (
                                    <>
                                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                                      </svg>
                                      {changeset.commitSha ? 'Revert (creates new changeset)' : 'Revert Changes'}
                                    </>
                                  )}
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Publish Button for committed changesets */}
                        {changeset.status === 'committed' && (
                          <div className="pt-2 space-y-3" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                            <div className="flex items-center justify-between gap-2 bg-accent-green/20 border border-accent-green/30 rounded-lg p-3">
                              <div>
                                <div className="flex items-center gap-2">
                                  <svg className="w-4 h-4 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                  </svg>
                                  <span className="text-sm text-accent-green font-medium">Ready to Publish</span>
                                </div>
                                <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>Code verified and committed</p>
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPublishChangesetId(changeset.id);
                                  setIsPublishPanelOpen(true);
                                }}
                                className="flex items-center gap-2"
                                style={getReviewActionButtonStyle({ tone: 'purple', active: true })}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                </svg>
                                Publish
                              </button>
                            </div>

                            {/* Revert Button for committed changesets */}
                            {confirmRevert === changeset.id ? (
                              <div className="flex items-center justify-between gap-2 bg-accent-yellow/20 border border-accent-yellow rounded p-2">
                                <div className="text-xs text-accent-yellow">
                                  <p>This will create a new changeset that undoes these changes.</p>
                                  <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>Git history is preserved.</p>
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => setConfirmRevert(null)}
                                    style={getReviewActionButtonStyle({ tone: 'neutral' })}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => handleRevert(changeset)}
                                    disabled={isReverting === changeset.id}
                                    style={getReviewActionButtonStyle({ tone: 'red', active: true, disabled: isReverting === changeset.id })}
                                  >
                                    Confirm
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRevert(changeset);
                                }}
                                disabled={isReverting === changeset.id}
                                className="w-full flex items-center justify-center gap-2"
                                style={{ ...getReviewActionButtonStyle({ tone: 'red', disabled: isReverting === changeset.id }), width: '100%' }}
                                title="Creates a new changeset - does not modify git history"
                              >
                                {isReverting === changeset.id ? (
                                  <>
                                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Reverting...
                                  </>
                                ) : (
                                  <>
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                                    </svg>
                                    Revert (creates new changeset)
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        )}

                        {/* Reapply Button for reverted changesets */}
                        {changeset.status === 'reverted' && (
                          <div className="pt-2" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleReapply(changeset);
                              }}
                              disabled={isReapplying === changeset.id}
                              className="w-full flex items-center justify-center gap-2"
                              style={{ ...getReviewActionButtonStyle({ tone: 'green', active: true, disabled: isReapplying === changeset.id }), width: '100%' }}
                            >
                              {isReapplying === changeset.id ? (
                                <>
                                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                  </svg>
                                  Reapplying...
                                </>
                              ) : (
                                <>
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                  </svg>
                                  Reapply Changes
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Commit Modal */}
      {commitModalId && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: 'color-mix(in srgb, var(--review-shell-bg) 36%, transparent)' }}>
          <div className="w-96 max-w-[90vw]" style={{ background: 'var(--review-panel-bg)', border: '1px solid var(--review-shell-border-strong)', borderRadius: 20, boxShadow: 'var(--review-panel-shadow)', overflow: 'hidden' }}>
            <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-header-bg)' }}>
              <h3 className="text-lg font-medium" style={{ color: 'var(--text-primary)' }}>Commit to Git</h3>
            </div>
            <div className="space-y-4" style={{ padding: 'var(--space-4)' }}>
              <div>
                <label htmlFor="commit-message" className="block text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>
                  Commit Message
                </label>
                <textarea
                  id="commit-message"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  className="w-full px-3 py-2 rounded text-sm focus:outline-none"
                  style={{ background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border-strong)', color: 'var(--text-primary)' }}
                  rows={3}
                  placeholder="Enter commit message..."
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => {
                    setCommitModalId(null);
                    setCommitMessage('');
                  }}
                  style={getReviewActionButtonStyle({ tone: 'neutral' })}
                >
                  Cancel
                </button>
                <button
                  onClick={handleCommit}
                  disabled={!commitMessage.trim()}
                  style={getReviewActionButtonStyle({ tone: 'blue', active: true, disabled: !commitMessage.trim() })}
                >
                  Commit
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Publish Panel Modal */}
      <PublishPanel
        projectId={projectId}
        isOpen={isPublishPanelOpen}
        onClose={() => {
          setIsPublishPanelOpen(false);
          setPublishChangesetId(null);
        }}
        initialChangesetId={publishChangesetId}
        onNavigateToChangeset={(changesetId) => {
          // Expand the changeset to show verification section
          handleToggleExpand(changesetId);
        }}
        onChangesetUpdated={loadChangesets}
        onDeploymentStarted={(changesetId) => {
          // Update local state to show deploying status inline
          setChangesets(prev =>
            prev.map(cs =>
              cs.id === changesetId
                ? {
                    ...cs,
                    deployment: {
                      url: '',
                      status: 'running' as const,
                      deployedAt: null,
                    },
                  }
                : cs
            )
          );
        }}
        onDeploymentComplete={(url, changesetId, deployment) => {
          // Immediately update local state with deployment info for instant UI feedback
          if (changesetId && deployment) {
            setChangesets(prev =>
              prev.map(cs =>
                cs.id === changesetId
                  ? {
                      ...cs,
                      status: 'published' as const,
                      deployment,
                    }
                  : cs
              )
            );
            // Also update expanded changeset if it matches
            if (expandedChangeset?.id === changesetId) {
              setExpandedChangeset(prev =>
                prev ? { ...prev, status: 'published' as const } : null
              );
            }
          }
          loadProductionStatus();
          loadChangesets(); // Still refresh to sync with server
          onDeploymentComplete?.(url);
        }}
        onOpenGlobalSettingsSection={onOpenGlobalSettingsSection}
      />
    </div>
  );
}

export default ChangeSetsPanel;
