/**
 * PublishPanel Component
 * Modal to publish a project with verification gate
 */

import { useState, useEffect, useRef } from 'react';
import toast from '@/lib/toast';
import { publishApi, changesetApi, atlasHostingApi } from '@/services/api';
import type { PublishStatus, PublishMethod, AtlasHostingStatus, DatabaseProvisioning } from '@/services/api';
import type { VerificationStatus, ChangeSetDeployment } from '@/types';
import { useGitStatus } from '@/hooks/useGitStatus';
import SupabaseProvisioningWizard from './SupabaseProvisioningWizard';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface PublishPanelProps {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
  onNavigateToChangeset?: (changesetId: string) => void;
  onChangesetUpdated?: () => void;
  onDeploymentComplete?: (url: string, changesetId?: string, deployment?: ChangeSetDeployment) => void;
  onDeploymentStarted?: (changesetId: string) => void;
  initialChangesetId?: string | null;
  onOpenGlobalSettingsSection?: (section: 'github' | 'cloud') => void;
  onSendFixMessage?: (message: string) => void;
}

function PublishPanel({ projectId, isOpen, onClose, onChangesetUpdated, onDeploymentComplete, onDeploymentStarted, initialChangesetId, onOpenGlobalSettingsSection, onSendFixMessage }: PublishPanelProps) {
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isCommittingWorkingTree, setIsCommittingWorkingTree] = useState(false);
  const [selectedChangesetId, setSelectedChangesetId] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{
    success: boolean;
    logs?: string;
    url?: string;
    error?: string;
  } | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  const [lastFailedLogs, setLastFailedLogs] = useState<string | null>(null);

  // Database provisioning state
  const [dbProvisioning, setDbProvisioning] = useState<DatabaseProvisioning | null>(null);
  const [dbProvisioningComplete, setDbProvisioningComplete] = useState(false);

  // Atlas Hosting state
  const [atlasHostingStatus, setAtlasHostingStatus] = useState<AtlasHostingStatus | null>(null);
  const [isAtlasPublishing, setIsAtlasPublishing] = useState(false);
  const [atlasLogs, setAtlasLogs] = useState<string[]>([]);
  const [showAtlasLogs, setShowAtlasLogs] = useState(true);
  const atlasLogsRef = useRef<HTMLPreElement>(null);
  const cleanupRef = useRef<(() => void)>(() => {});
  const logsAccumulatorRef = useRef<string>(''); // Track logs for closure access

  // Git status for GitHub connection check
  const { status: gitStatus, loading: gitLoading } = useGitStatus(isOpen ? projectId : null, {
    enablePolling: false, // Only fetch once when modal opens
  });

  // Load publish status when modal opens
  useEffect(() => {
    if (isOpen && projectId) {
      loadPublishStatus();
      loadAtlasHostingStatus();
    }
  }, [isOpen, projectId]);

  // Cleanup SSE connection on unmount (separate effect to ensure cleanup always runs)
  useEffect(() => {
    return () => {
      cleanupRef.current();
    };
  }, []);

  // Auto-scroll atlas logs
  useEffect(() => {
    if (atlasLogsRef.current) {
      atlasLogsRef.current.scrollTop = atlasLogsRef.current.scrollHeight;
    }
  }, [atlasLogs]);

  const loadAtlasHostingStatus = async () => {
    try {
      const result = await atlasHostingApi.getStatus();
      setAtlasHostingStatus(result);
    } catch (error) {
      console.error('Failed to load Atlas Hosting status:', error);
      setAtlasHostingStatus({ enabled: false, reason: 'Failed to check status' });
    }
  };

  const loadPublishStatus = async () => {
    setIsLoading(true);
    setPublishResult(null);
    try {
      const result = await publishApi.getStatus(projectId);
      setStatus(result);

      // Update database provisioning state
      // Only gate deploy on Supabase provisioning when the project actually uses
      // @supabase/supabase-js. Non-Supabase DB packages (pg, prisma, mysql, etc.)
      // are covered by the existing secretsReady / DATABASE_URL check.
      if (result.databaseProvisioning) {
        setDbProvisioning(result.databaseProvisioning);
        const dp = result.databaseProvisioning;
        const isSupabaseType = dp.dbType === 'supabase';
        setDbProvisioningComplete(
          !dp.needsDatabase || !isSupabaseType || dp.supabaseLinked
        );
      } else {
        setDbProvisioning(null);
        setDbProvisioningComplete(true);
      }

      // Set the default selected changeset
      // If initialChangesetId is provided and exists in eligible list, use it
      // Otherwise, default to the most recent changeset (first in the list, already sorted by date)
      if (initialChangesetId && result.eligibleChangesets?.some(cs => cs.id === initialChangesetId)) {
        setSelectedChangesetId(initialChangesetId);
      } else if (result.eligibleChangesets && result.eligibleChangesets.length > 0) {
        // Default to the most recent changeset (first in list)
        // This ensures users see their latest work, even if it's already published
        setSelectedChangesetId(result.eligibleChangesets[0].id);
      } else if (result.latestChangeset) {
        setSelectedChangesetId(result.latestChangeset.id);
      }
    } catch (error: any) {
      console.error('Failed to load publish status:', error);
      toast.error(error.response?.data?.error || 'Failed to load publish status');
    } finally {
      setIsLoading(false);
    }
  };

  const handlePublish = async () => {
    setIsPublishing(true);
    setPublishResult(null);
    try {
      const result = await publishApi.publish(projectId, selectedChangesetId || undefined);
      setPublishResult(result);
      if (result.success) {
        toast.success('Published successfully!');
      } else {
        toast.error(result.error || 'Publish failed');
      }
    } catch (error: any) {
      console.error('Failed to publish:', error);
      const errorMessage = error.response?.data?.error || error.response?.data?.reason || 'Failed to publish';
      setPublishResult({
        success: false,
        error: errorMessage,
        logs: error.response?.data?.logs,
      });
      toast.error(errorMessage);
    } finally {
      setIsPublishing(false);
    }
  };

  const handleCommit = async () => {
    if (!selectedChangesetId) return;

    setIsCommitting(true);
    try {
      await changesetApi.commit(projectId, selectedChangesetId);
      toast.success('Changeset committed successfully!');
      // Refresh status to update preflight info
      await loadPublishStatus();
      // Notify parent to refresh changeset list
      onChangesetUpdated?.();
    } catch (error: any) {
      console.error('Failed to commit:', error);
      const errorMessage = error.response?.data?.error || error.response?.data?.blockedReason || 'Failed to commit';
      toast.error(errorMessage);
    } finally {
      setIsCommitting(false);
    }
  };

  const handleCommitWorkingTree = async () => {
    setIsCommittingWorkingTree(true);
    try {
      await publishApi.commitWorkingTree(projectId, 'Commit uncommitted changes before deploy');
      toast.success('Working tree committed successfully!');
      // Refresh status to update preflight info
      await loadPublishStatus();
      // Notify parent to refresh changeset list
      onChangesetUpdated?.();
    } catch (error: any) {
      console.error('Failed to commit working tree:', error);
      const errorMessage = error.response?.data?.error || 'Failed to commit working tree';
      toast.error(errorMessage);
    } finally {
      setIsCommittingWorkingTree(false);
    }
  };

  const handleRunChecks = async () => {
    if (!selectedChangesetId || !status?.availableChecks) return;

    const checks = (status.availableChecks.checks || []).filter((c) => c.enabled !== false);
    const checksToRun: string[] = checks.map((c) => c.id);

    if (checksToRun.length === 0) {
      toast.error('No verification checks available for this project');
      return;
    }

    setIsRunningChecks(true);
    try {
      const result = await changesetApi.runVerification(projectId, selectedChangesetId, checksToRun);

      const passed = Object.values(result.results).filter((r: any) => r.status === 'pass').length;
      const failed = Object.values(result.results).filter((r: any) => r.status === 'fail').length;

      if (failed === 0) {
        if (result.autoCommitted) {
          toast.success(`All ${passed} checks passed — auto-committed ${result.commitSha?.substring(0, 7)}`);
        } else {
          toast.success(`All ${passed} checks passed`);
        }
      } else {
        toast.error(`${failed} check(s) failed, ${passed} passed`);
        // Store failed check logs for "Ask AI to fix" button
        const failedLogs = Object.values(result.results)
          .filter((r: any) => r.status === 'fail')
          .map((r: any) => `[${r.kind || r.checkId}] ${r.logs || 'No output'}`)
          .join('\n\n');
        setLastFailedLogs(failedLogs);
      }

      // Refresh publish status to update readiness gate
      await loadPublishStatus();
      // Notify parent to refresh changeset list
      onChangesetUpdated?.();
    } catch (error: any) {
      console.error('Failed to run verification:', error);
      toast.error(error.response?.data?.error || 'Failed to run verification checks');
    } finally {
      setIsRunningChecks(false);
    }
  };

  const handleAtlasPublish = async () => {
    if (!selectedChangesetId) return;

    const selected = status?.eligibleChangesets?.find(cs => cs.id === selectedChangesetId);

    setIsAtlasPublishing(true);
    setAtlasLogs([]);
    logsAccumulatorRef.current = ''; // Reset logs accumulator
    setPublishResult(null);
    setShowAtlasLogs(true);

    try {
      // Auto-commit the changeset if not already committed
      let commitSha = selected?.commitSha;
      if (!commitSha) {
        setAtlasLogs((prev) => [...prev, 'Auto-committing changeset for deploy...\n']);
        const commitResult = await changesetApi.commit(projectId, selectedChangesetId);
        const sha = commitResult.commitSha;
        if (!sha) {
          throw new Error('Commit succeeded but no commit SHA returned');
        }
        commitSha = sha;
        setAtlasLogs((prev) => [...prev, `Committed: ${sha.substring(0, 7)}\n`]);
        // Refresh status in background so UI updates
        loadPublishStatus();
        onChangesetUpdated?.();
      }

      // Start the publish attempt
      const { publishAttemptId } = await atlasHostingApi.startPublish(
        projectId,
        selectedChangesetId,
        commitSha
      );

      // Notify parent that deployment has started
      onDeploymentStarted?.(selectedChangesetId);

      // Subscribe to SSE events
      const cleanup = atlasHostingApi.subscribeToEvents(publishAttemptId, {
        onLog: (text) => {
          logsAccumulatorRef.current += text; // Track in ref for closure access
          setAtlasLogs((prev) => [...prev, text]);
        },
        onStatus: (newStatus) => {
          console.log('Deployment status:', newStatus);
        },
        onComplete: (data) => {
          setPublishResult({
            success: true,
            url: data.url,
            logs: logsAccumulatorRef.current, // Use ref to get all accumulated logs
          });
          toast.success(usesVercelManagedDeploy ? 'Deployed to Vercel successfully!' : 'Published to Atlas Hosting successfully!');
          setIsAtlasPublishing(false);
          cleanupRef.current();
          cleanupRef.current = () => {};
          // Refresh status
          loadPublishStatus();
          // Notify parent of deployment completion with full deployment data
          // Parent will handle both UI update and changeset refresh
          if (data.url && selectedChangesetId) {
            onDeploymentComplete?.(data.url, selectedChangesetId, {
              url: data.url,
              status: 'succeeded',
              deployedAt: new Date().toISOString(),
            });
          } else if (data.url) {
            onDeploymentComplete?.(data.url);
          }
        },
        onError: (error) => {
          setPublishResult({
            success: false,
            error: error,
            logs: logsAccumulatorRef.current, // Use ref to get all accumulated logs
          });
          toast.error(error || (usesVercelManagedDeploy ? 'Vercel deployment failed' : 'Atlas Hosting deployment failed'));
          setIsAtlasPublishing(false);
          cleanupRef.current();
          cleanupRef.current = () => {};
        },
      });

      cleanupRef.current = cleanup;
    } catch (error: any) {
      console.error('Failed to start Atlas Hosting publish:', error);
      const errorMessage = error.response?.data?.error || error.response?.data?.details || 'Failed to start deployment';
      setPublishResult({
        success: false,
        error: errorMessage,
      });
      toast.error(errorMessage);
      setIsAtlasPublishing(false);
    }
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

  const getVerificationBadge = (checkStatus: VerificationStatus, label: string, isAvailable: boolean) => {
    // Not configured - show N/A badge
    if (!isAvailable) {
      return (
        <span className="px-2 py-0.5 rounded text-xs flex items-center gap-1" style={{ background: 'var(--review-chip-neutral-bg)', color: 'var(--text-tertiary)', border: '1px solid var(--review-chip-neutral-border)' }}>
          <span className="text-[10px] font-medium">N/A</span>
          <span className="opacity-60">{label}</span>
        </span>
      );
    }
    // Configured but not run
    if (checkStatus === 'not_run') {
      return (
        <span className="px-2 py-0.5 rounded text-xs" style={{ background: 'var(--review-chip-neutral-bg)', color: 'var(--text-secondary)', border: '1px solid var(--review-shell-border)' }}>
          {label}
        </span>
      );
    }
    // Configured and passed
    if (checkStatus === 'pass') {
      return (
        <span className="px-2 py-0.5 rounded text-xs bg-accent-green/20 text-accent-green border border-accent-green/30 flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {label}
        </span>
      );
    }
    // Configured and failed
    return (
      <span className="px-2 py-0.5 rounded text-xs bg-accent-red/20 text-accent-red border border-accent-red/30 flex items-center gap-1">
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
        {label}
      </span>
    );
  };

  const getPublishMethodDisplay = (method: PublishMethod) => {
    if (method.method === 'vercel') {
      return (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
          <svg className="w-4 h-4" viewBox="0 0 76 65" fill="currentColor">
            <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
          </svg>
          <span>Vercel</span>
        </div>
      );
    }
    if (method.method === 'script') {
      return (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>npm run deploy</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
        </svg>
        <span>Manual</span>
      </div>
    );
  };

  if (!isOpen) return null;

  const desktopNeedsVercelSetup = Boolean(
    status
    && status.publishMethod.method === 'vercel'
    && !atlasHostingStatus?.enabled
  );
  const usesVercelManagedDeploy = status?.publishMethod.method === 'vercel';

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: 'rgba(var(--bg-base-rgb), 0.58)', backdropFilter: 'blur(12px)' }}>
      <div
        className="w-[480px] max-w-[90vw] max-h-[85vh] flex flex-col"
        style={{
          background: 'var(--review-panel-bg)',
          border: '1px solid var(--review-shell-border)',
          borderRadius: 24,
          boxShadow: 'var(--review-panel-shadow)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-header-bg)' }}>
          <h3 className="text-lg font-medium flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            Publish Project
          </h3>
          <button
            onClick={onClose}
            style={getReviewActionButtonStyle({ tone: 'neutral' })}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {isLoading ? (
            <div className="text-center py-8" style={{ color: 'var(--text-secondary)' }}>
              <svg className="w-6 h-6 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Loading publish status...
            </div>
          ) : status ? (
            <>
              {/* Changeset Selector */}
              {status.eligibleChangesets && status.eligibleChangesets.length > 0 ? (
                <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--review-card-bg)', border: '1px solid var(--review-shell-border)' }}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Changeset to Publish</span>
                    <div className="group relative">
                      <button title="Why this one?" style={{ color: 'var(--text-tertiary)' }}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </button>
                      <div className="absolute right-0 top-6 w-48 p-2 rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity z-10" style={{ background: 'var(--review-panel-header-bg)', color: 'var(--text-primary)', border: '1px solid var(--review-shell-border)', boxShadow: 'var(--review-panel-shadow)' }}>
                        Defaults to most recent changeset
                      </div>
                    </div>
                  </div>

                  {/* Dropdown Selector */}
                  <select
                    value={selectedChangesetId || ''}
                    onChange={(e) => setSelectedChangesetId(e.target.value)}
                    className="w-full px-3 py-2 rounded text-sm focus:outline-none"
                    style={{ background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border-strong)', color: 'var(--text-primary)' }}
                  >
                    {status.eligibleChangesets.map((cs) => (
                      <option key={cs.id} value={cs.id}>
                        {cs.displayId || 'CS-???'} • {cs.commitMessage || cs.title}
                      </option>
                    ))}
                  </select>

                  {/* Selected Changeset Summary Line */}
                  {selectedChangesetId && (() => {
                    const selected = status.eligibleChangesets.find(cs => cs.id === selectedChangesetId);
                    if (!selected) return null;
                    return (
                      <div className="space-y-2 pt-2" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                        {/* Summary Line: CS-001 • 2 files • 2m ago • Verified */}
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Display ID (primary) */}
                          <span className="px-2 py-0.5 rounded text-xs bg-accent-blue/20 text-accent-blue border border-accent-blue/30 font-mono font-medium">
                            {selected.displayId || 'CS-???'}
                          </span>
                          {selected.fileCount > 0 && (
                            <>
                              <span style={{ color: 'var(--text-tertiary)' }}>&bull;</span>
                              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                {selected.fileCount} file{selected.fileCount !== 1 ? 's' : ''}
                              </span>
                            </>
                          )}
                          <span style={{ color: 'var(--text-tertiary)' }}>&bull;</span>
                          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {formatRelativeTime(selected.createdAt)}
                          </span>
                          <span style={{ color: 'var(--text-tertiary)' }}>•</span>
                          {/* Status Badge */}
                          <span
                            className="px-2 py-0.5 rounded text-xs"
                            style={
                              selected.status === 'committed'
                                ? { background: 'var(--chip-ai-bg)', color: 'var(--accent-purple)', border: '1px solid rgba(var(--accent-purple-rgb), 0.24)' }
                                : selected.status === 'verified'
                                  ? { background: 'var(--chip-info-bg)', color: 'var(--accent-blue)', border: '1px solid var(--chip-info-border)' }
                                  : selected.status === 'published'
                                    ? { background: 'var(--chip-success-bg)', color: 'var(--accent-green)', border: '1px solid var(--chip-success-border)' }
                                    : { background: 'var(--review-chip-neutral-bg)', color: 'var(--text-secondary)', border: '1px solid var(--review-shell-border)' }
                            }
                          >
                            {selected.status.charAt(0).toUpperCase() + selected.status.slice(1)}
                          </span>
                          {/* Commit hash (secondary, optional) */}
                          {selected.commitSha && (
                            <>
                              <span style={{ color: 'var(--text-tertiary)' }}>•</span>
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ background: 'var(--review-code-bg)', color: 'var(--text-secondary)', border: '1px solid var(--review-shell-border)' }} title="Git commit">
                                Commit: {selected.commitSha.slice(0, 7)}
                              </span>
                            </>
                          )}
                        </div>

                        {/* Verification Badges */}
                        {selected.verification && status.availableChecks && (
                          <div className="flex flex-wrap gap-2">
                            {getVerificationBadge(selected.verification.lint, 'Lint', status.availableChecks.lint)}
                            {getVerificationBadge(selected.verification.unit, 'Unit', status.availableChecks.unit)}
                            {getVerificationBadge(selected.verification.e2e, 'E2E', status.availableChecks.e2e)}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ) : status.latestChangeset ? (
                <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--review-card-bg)', border: '1px solid var(--review-shell-border)' }}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>Changeset to Publish</span>
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {formatRelativeTime(status.latestChangeset.createdAt)}
                    </span>
                  </div>
                  <div className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {status.latestChangeset.title}
                  </div>

                  {/* Verification Badges */}
                  {status.latestChangeset.verification && status.availableChecks && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {getVerificationBadge(status.latestChangeset.verification.lint, 'Lint', status.availableChecks.lint)}
                      {getVerificationBadge(status.latestChangeset.verification.unit, 'Unit', status.availableChecks.unit)}
                      {getVerificationBadge(status.latestChangeset.verification.e2e, 'E2E', status.availableChecks.e2e)}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-lg p-4 text-center" style={{ background: 'var(--review-card-bg)', border: '1px solid var(--review-shell-border)', color: 'var(--text-secondary)' }}>
                  <svg className="w-8 h-8 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="text-sm">No applied changeset found</p>
                  <p className="text-xs mt-1">Make changes to your project first</p>
                </div>
              )}

              {/* Database Provisioning Wizard — only shown for Supabase-type DB needs */}
              {dbProvisioning?.needsDatabase && dbProvisioning.dbType === 'supabase' && !dbProvisioningComplete && (
                <SupabaseProvisioningWizard
                  projectId={projectId}
                  dbType={dbProvisioning.dbType || 'database'}
                  initialConnected={dbProvisioning.supabaseConnected}
                  initialLinked={dbProvisioning.supabaseLinked}
                  onComplete={() => {
                    setDbProvisioningComplete(true);
                    // Refresh publish-status to pick up new secrets
                    loadPublishStatus();
                  }}
                />
              )}

              {/* Preflight Status - derives from SELECTED changeset */}
              {status.preflight && selectedChangesetId && (() => {
                const selectedCs = status.eligibleChangesets?.find(cs => cs.id === selectedChangesetId);
                const isChangesetCommitted = !!selectedCs?.commitSha;

                return (
                  <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--review-card-bg)', border: '1px solid var(--review-shell-border)' }}>
                    <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>Preflight</div>
                    <div className="text-[10px] -mt-1" style={{ color: 'var(--text-tertiary)' }}>Publish deploys from current working directory</div>
                    <div className="space-y-1.5">
                      {/* Git Repository Status */}
                      {!status.preflight.isGitRepo ? (
                        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span>Not a git repository</span>
                        </div>
                      ) : (
                        <>
                          {/* Changeset Commit Status - PRIMARY CHECK */}
                          <div className="flex items-center gap-2 text-xs">
                            {isChangesetCommitted ? (
                              <>
                                <svg className="w-3.5 h-3.5 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span className="text-accent-green">Changeset committed</span>
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ background: 'var(--review-code-bg)', color: 'var(--text-secondary)', border: '1px solid var(--review-shell-border)' }}>
                                  {selectedCs?.commitSha?.slice(0, 7)}
                                </span>
                              </>
                            ) : (
                              <div className="flex items-center gap-2 flex-wrap">
                                <svg className="w-3.5 h-3.5 text-accent-red" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                                <span className="text-accent-red">Changeset not committed</span>
                                <button
                                  onClick={handleCommit}
                                  disabled={isCommitting}
                                  className="flex items-center gap-1"
                                  style={getReviewActionButtonStyle({ tone: 'purple', active: true, disabled: isCommitting })}
                                >
                                  {isCommitting ? (
                                    <>
                                      <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                      </svg>
                                      Committing...
                                    </>
                                  ) : (
                                    'Commit Changeset'
                                  )}
                                </button>
                              </div>
                            )}
                          </div>

                          {/* Working Tree Status - Warning that uncommitted changes will be included */}
                          {!status.preflight.workingTreeClean && (
                            <div className="flex items-center gap-2 text-xs text-accent-yellow flex-wrap">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                              </svg>
                              <span>Working tree has uncommitted changes</span>
                              <button
                                onClick={handleCommitWorkingTree}
                                disabled={isCommittingWorkingTree}
                                className="flex items-center gap-1"
                                style={getReviewActionButtonStyle({ tone: 'yellow', active: true, disabled: isCommittingWorkingTree })}
                              >
                                {isCommittingWorkingTree ? (
                                  <>
                                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Committing...
                                  </>
                                ) : (
                                  'Commit All'
                                )}
                              </button>
                            </div>
                          )}

                          {/* GitHub Connection Status - Warning when not connected */}
                          {!gitLoading && gitStatus && !gitStatus.isGitHub && (
                            <div className="flex items-center gap-2 text-xs text-accent-yellow flex-wrap">
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                              </svg>
                              <span>GitHub not connected</span>
                              {onOpenGlobalSettingsSection && (
                                <button
                                  onClick={() => {
                                    onClose();
                                    onOpenGlobalSettingsSection('github');
                                  }}
                                  className="flex items-center gap-1"
                                  style={getReviewActionButtonStyle({ tone: 'neutral' })}
                                >
                                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                                  </svg>
                                  Connect
                                </button>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Code Readiness Status - derived from selected changeset */}
              {(() => {
                const selected = status.eligibleChangesets?.find(cs => cs.id === selectedChangesetId);

                // Derive readiness from selected changeset
                let isCodeReady = false;
                let readinessReason = '';

                if (selected) {
                  // 'verified' status means all checks passed (set by verification endpoint)
                  // 'published' status means it was already published
                  // Note: 'committed' does NOT guarantee checks passed - commits can happen before verification
                  if (['verified', 'published'].includes(selected.status)) {
                    isCodeReady = true;
                    readinessReason = 'All configured checks passed';
                  } else if (status.availableChecks) {
                    // Check individual verification status against available checks
                    const checks = status.availableChecks;
                    const verification = selected.verification || { lint: 'not_run', unit: 'not_run', e2e: 'not_run' };

                    const lintOk = !checks.lint || verification.lint === 'pass';
                    const unitOk = !checks.unit || verification.unit === 'pass';
                    const e2eOk = !checks.e2e || verification.e2e === 'pass';

                    if (lintOk && unitOk && e2eOk) {
                      // Check if any checks were actually configured and run
                      const hasConfiguredChecks = checks.lint || checks.unit || checks.e2e;
                      const hasRunChecks = verification.lint !== 'not_run' || verification.unit !== 'not_run' || verification.e2e !== 'not_run';

                      if (!hasConfiguredChecks) {
                        isCodeReady = true;
                        readinessReason = 'No checks configured';
                      } else if (hasRunChecks) {
                        isCodeReady = true;
                        readinessReason = 'All configured checks passed';
                      } else {
                        isCodeReady = false;
                        readinessReason = 'Run checks to verify code';
                      }
                    } else {
                      isCodeReady = false;
                      // Build specific blocker message
                      const blockers: string[] = [];
                      if (checks.lint && verification.lint === 'fail') blockers.push('Lint');
                      if (checks.unit && verification.unit === 'fail') blockers.push('Unit tests');
                      if (checks.e2e && verification.e2e === 'fail') blockers.push('E2E tests');
                      if (checks.lint && verification.lint === 'not_run') blockers.push('Lint (not run)');
                      if (checks.unit && verification.unit === 'not_run') blockers.push('Unit (not run)');
                      if (checks.e2e && verification.e2e === 'not_run') blockers.push('E2E (not run)');
                      readinessReason = blockers.length > 0 ? `Blocked: ${blockers.join(', ')}` : 'Run checks to verify code';
                    }
                  } else {
                    isCodeReady = false;
                    readinessReason = 'Run checks to verify code';
                  }
                } else {
                  isCodeReady = false;
                  readinessReason = 'No changeset selected';
                }

                return (
                  <div className={`rounded-lg p-3 ${
                    isCodeReady
                      ? 'bg-accent-green/20 border border-accent-green/30'
                      : 'bg-accent-red/20 border border-accent-red/30'
                  }`}>
                    <div className="flex items-center gap-2">
                      {isCodeReady ? (
                        <>
                          <svg className="w-5 h-5 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span className="text-accent-green font-medium">Code Ready</span>
                        </>
                      ) : (
                        <>
                          <svg className="w-5 h-5 text-accent-red" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span className="text-accent-red font-medium">Code Not Ready</span>
                        </>
                      )}
                    </div>
                    <p className={`text-sm mt-1 ${isCodeReady ? 'text-accent-green/70' : 'text-accent-red/70'}`}>
                      {readinessReason}
                    </p>

                    {/* Verify / Re-run button when blocked by not-run or failed checks */}
                    {!isCodeReady && selectedChangesetId && (
                      <button
                        onClick={handleRunChecks}
                        disabled={isRunningChecks}
                        className="mt-3 flex items-center gap-2"
                        style={getReviewActionButtonStyle({ tone: 'purple', active: true, disabled: isRunningChecks })}
                      >
                        {isRunningChecks ? (
                          <>
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Verifying...
                          </>
                        ) : readinessReason.toLowerCase().includes('not run') ? (
                          'Verify'
                        ) : (
                          'Re-run Checks'
                        )}
                      </button>
                    )}
                    {/* Ask AI to fix failed checks */}
                    {!isCodeReady && lastFailedLogs && !readinessReason.toLowerCase().includes('not run') && (
                      <button
                        onClick={() => {
                          const fixPrompt = `The following verification checks failed. Please fix these errors:\n\n${lastFailedLogs}`;
                          if (onSendFixMessage) {
                            onSendFixMessage(fixPrompt);
                          } else {
                            // Dispatch event for ChatPanel to pick up
                            window.dispatchEvent(new CustomEvent('atlas-send-chat-message', { detail: { message: fixPrompt, mode: 'build' } }));
                          }
                          onClose();
                        }}
                        className="mt-2 flex items-center gap-2"
                        style={getReviewActionButtonStyle({ tone: 'blue', active: true, disabled: false })}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        Ask AI to Fix
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* Show setup hint when Vercel is not configured */}
              {!atlasHostingStatus?.enabled && (
                <div className="rounded-lg p-3" style={{ background: 'var(--review-card-bg)', border: '1px solid var(--review-shell-border)' }}>
                  <div className="flex items-center gap-2 mb-2">
                    <svg className="w-5 h-5" style={{ color: 'var(--text-tertiary)' }} viewBox="0 0 76 65" fill="currentColor">
                      <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
                    </svg>
                    <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Vercel Deployment</span>
                  </div>
                  <p className="text-sm mb-3" style={{ color: 'var(--text-tertiary)' }}>
                    {atlasHostingStatus?.reason || 'Connect your Vercel account to enable one-click deployment.'}
                  </p>
                  {onOpenGlobalSettingsSection && (
                    <button
                      onClick={() => {
                        onClose();
                        onOpenGlobalSettingsSection('cloud');
                      }}
                      className="flex items-center gap-2"
                      style={getReviewActionButtonStyle({ tone: 'purple', active: true })}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      Configure Vercel
                    </button>
                  )}
                </div>
              )}

              {/* Atlas Hosting / Vercel Deployment Section */}
              {atlasHostingStatus?.enabled && (
                <div className="bg-gradient-to-r from-purple-900/30 to-blue-900/30 rounded-lg p-3 border border-purple-600/30">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      <span className="text-purple-400 font-medium">{usesVercelManagedDeploy ? 'Vercel Deployment' : 'Atlas Hosting'}</span>
                      <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-300 text-[10px] rounded">BETA</span>
                    </div>
                  </div>
                  <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
                    {usesVercelManagedDeploy ? 'One-click deployment to Vercel' : 'One-click deployment to *.atlasengine.dev with SSL'}
                  </p>

                  {/* Show streaming logs during deployment */}
                  {isAtlasPublishing && (
                    <div className="mb-3">
                      <button
                        onClick={() => setShowAtlasLogs(!showAtlasLogs)}
                        className="flex items-center gap-1 text-xs mb-2"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <svg
                          className={`w-3 h-3 transition-transform ${showAtlasLogs ? 'rotate-90' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        Deployment Logs
                      </button>
                      {showAtlasLogs && (
                        <pre
                          ref={atlasLogsRef}
                          className="text-xs whitespace-pre-wrap break-words font-mono rounded p-2 max-h-48 overflow-y-auto"
                          style={{ background: 'var(--review-code-bg)', color: 'var(--text-primary)', border: '1px solid var(--review-shell-border)' }}
                        >
                          {atlasLogs.join('') || 'Connecting to deployment server...'}
                        </pre>
                      )}
                    </div>
                  )}

                  {/* Missing Secrets Warning */}
                  {status?.secretsReady === false && status.missingSecrets && status.missingSecrets.length > 0 && (
                    <div className="mb-3 p-2 bg-yellow-900/30 border border-yellow-600/30 rounded-lg">
                      <div className="flex items-center gap-2 text-accent-yellow text-sm font-medium mb-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        Missing required environment variables
                      </div>
                      <div className="space-y-1 mb-2">
                        {status.missingSecrets.map((secret, index) => (
                          <div key={index} className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-primary)' }}>
                            <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border)' }}>{secret.key}</span>
                            <span style={{ color: 'var(--text-tertiary)' }}>({secret.integration})</span>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-accent-yellow/70">
                        Configure secrets in <span className="font-medium">Settings &gt; Secrets</span> before publishing.
                      </p>
                    </div>
                  )}

                  {/* Deploy Button */}
                  {(() => {
                    const selected = status?.eligibleChangesets?.find(cs => cs.id === selectedChangesetId);
                    const isCommitted = !!selected?.commitSha;

                    // Check if verification passed (same logic as main publish)
                    let canPublish = false;
                    if (selected) {
                      if (['verified', 'published'].includes(selected.status)) {
                        canPublish = true;
                      } else if (status?.availableChecks) {
                        const checks = status.availableChecks;
                        const verification = selected.verification || { lint: 'not_run', unit: 'not_run', e2e: 'not_run' };

                        const lintOk = !checks.lint || verification.lint === 'pass';
                        const unitOk = !checks.unit || verification.unit === 'pass';
                        const e2eOk = !checks.e2e || verification.e2e === 'pass';

                        if (lintOk && unitOk && e2eOk) {
                          const hasConfiguredChecks = checks.lint || checks.unit || checks.e2e;
                          const hasRunChecks = verification.lint !== 'not_run' || verification.unit !== 'not_run' || verification.e2e !== 'not_run';
                          canPublish = !hasConfiguredChecks || hasRunChecks;
                        }
                      }
                    }

                    // Also block if secrets are missing
                    const secretsReady = status?.secretsReady !== false;
                    // Block if database provisioning is needed but not complete
                    const dbReady = dbProvisioningComplete;
                    // Note: !isCommitted removed — deploy auto-commits the changeset.
                    // Respect the verification gate — if checks are configured and have
                    // failed or not been run, block deployment to match the backend policy.
                    const hasConfiguredChecks = status?.availableChecks?.hasChecks;
                    const checksBlocking = hasConfiguredChecks && !canPublish;
                    const disabled = isAtlasPublishing || !secretsReady || !dbReady || checksBlocking;

                    return (
                      <div className="space-y-2">
                        <button
                          onClick={handleAtlasPublish}
                          disabled={disabled}
                          className="w-full flex items-center justify-center gap-2"
                          style={getReviewActionButtonStyle({ tone: 'purple', active: !disabled, disabled })}
                          title={!secretsReady ? 'Configure missing secrets to enable deployment' : !dbReady ? 'Set up a production database to enable deployment' : checksBlocking ? 'Run and pass verification checks before deploying' : undefined}
                        >
                          {isAtlasPublishing ? (
                            <>
                              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                              {usesVercelManagedDeploy ? 'Deploying to Vercel...' : 'Deploying to Atlas Hosting...'}
                            </>
                          ) : (
                            <>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                              </svg>
                              {usesVercelManagedDeploy ? 'Deploy to Vercel' : 'Deploy to Atlas Hosting'}
                            </>
                          )}
                        </button>
                        {!isCommitted && !isAtlasPublishing && (
                          <p className="text-xs text-center" style={{ color: 'var(--text-secondary)' }}>Changeset will be auto-committed on deploy</p>
                        )}
                        {checksBlocking && secretsReady && dbReady && (
                          <p className="text-xs text-accent-yellow text-center">Pass verification checks before deploying</p>
                        )}
                        {!secretsReady && (
                          <p className="text-xs text-accent-yellow text-center">Configure missing secrets first</p>
                        )}
                        {!dbReady && secretsReady && (
                          <p className="text-xs text-accent-yellow text-center">Set up a production database above to deploy</p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* External Deployment Status - only show when Atlas Hosting is NOT enabled */}
              {/* When Atlas Hosting is enabled, it's the primary method and we hide external options */}
              {!atlasHostingStatus?.enabled && (
              <div className={`rounded-lg p-3 ${
                status.publishMethod.method !== 'manual' && !desktopNeedsVercelSetup
                  ? 'bg-accent-green/20 border border-accent-green/30'
                  : 'bg-yellow-900/20 border border-yellow-600/30'
              }`}>
                <div className="flex items-center gap-2">
                  {status.publishMethod.method !== 'manual' && !desktopNeedsVercelSetup ? (
                    <>
                      <svg className="w-5 h-5 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="text-accent-green font-medium">Deployment Configured</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-5 h-5 text-accent-yellow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span className="text-accent-yellow font-medium">Deployment Not Configured</span>
                    </>
                  )}
                </div>
                <p className={`text-sm mt-1 ${
                  status.publishMethod.method !== 'manual' && !desktopNeedsVercelSetup ? 'text-accent-green/70' : 'text-accent-yellow/70'
                }`}>
                  {status.publishMethod.method === 'vercel' && desktopNeedsVercelSetup && 'Vercel CLI detected, but Atlas still needs your Vercel token'}
                  {status.publishMethod.method === 'vercel' && !desktopNeedsVercelSetup && 'Vercel CLI detected'}
                  {status.publishMethod.method === 'script' && 'Deploy script found in package.json'}
                  {status.publishMethod.method === 'manual' && 'Choose a deploy method to publish from Atlas'}
                </p>

                {desktopNeedsVercelSetup && (
                  <div className="mt-3 pt-3 space-y-3" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                    <p className="text-xs text-accent-yellow/80">
                      Atlas publishes using your Vercel account from inside the app. Local CLI login is not enough for this flow.
                    </p>
                    {onOpenGlobalSettingsSection && (
                      <button
                        onClick={() => {
                          onClose();
                          onOpenGlobalSettingsSection('cloud');
                        }}
                        style={getReviewActionButtonStyle({ tone: 'yellow', active: true })}
                      >
                        Open Vercel Setup
                      </button>
                    )}
                  </div>
                )}

                {/* Deploy Method Display */}
                <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                  {getPublishMethodDisplay(status.publishMethod)}
                </div>

                {/* Manual deploy commands with copy buttons */}
                {status.publishMethod.method === 'manual' && status.publishMethod.deployCommands && (
                  <div className="mt-3 space-y-3">
                    {/* Package Manager Badge */}
                    {status.publishMethod.packageManager && (
                      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <span>Detected:</span>
                        <span className="px-2 py-0.5 rounded font-mono" style={{ background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border)' }}>
                          {status.publishMethod.packageManager}
                        </span>
                      </div>
                    )}

                    {/* Install Command */}
                    <div className="space-y-1">
                      <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Step 1: Install Vercel CLI</div>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 rounded text-sm font-mono" style={{ background: 'var(--review-code-bg)', color: 'var(--text-primary)', border: '1px solid var(--review-shell-border)' }}>
                          {status.publishMethod.deployCommands.install}
                        </code>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(status.publishMethod.deployCommands!.install);
                            toast.success('Copied to clipboard!');
                          }}
                          style={getReviewActionButtonStyle({ tone: 'neutral' })}
                          title="Copy to clipboard"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* Deploy Command */}
                    <div className="space-y-1">
                      <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Step 2: Deploy to production</div>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 px-3 py-2 rounded text-sm font-mono" style={{ background: 'var(--review-code-bg)', color: 'var(--text-primary)', border: '1px solid var(--review-shell-border)' }}>
                          {status.publishMethod.deployCommands.deploy}
                        </code>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(status.publishMethod.deployCommands!.deploy);
                            toast.success('Copied to clipboard!');
                          }}
                          style={getReviewActionButtonStyle({ tone: 'neutral' })}
                          title="Copy to clipboard"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* Copy All Commands Button */}
                    <button
                      onClick={() => {
                        const commands = `${status.publishMethod.deployCommands!.install}\n${status.publishMethod.deployCommands!.deploy}`;
                        navigator.clipboard.writeText(commands);
                        toast.success('Copied both commands to clipboard!');
                      }}
                      className="w-full mt-2 flex items-center justify-center gap-2"
                      style={getReviewActionButtonStyle({ tone: 'purple', active: true })}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy Deploy Commands
                    </button>

                    {/* Alternative: Add deploy script */}
                    <div className="pt-2" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                      <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        Or add a <code className="px-1 py-0.5 rounded" style={{ background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border)' }}>"deploy"</code> script to package.json for one-click publish
                      </div>
                    </div>
                  </div>
                )}
              </div>
              )}

              {/* Publish Result */}
              {publishResult && (
                <div className={`rounded-lg p-3 ${
                  publishResult.success
                    ? 'bg-accent-green/20 border border-accent-green/30'
                    : 'bg-accent-red/20 border border-accent-red/30'
                }`}>
                  <div className="flex items-center gap-2 mb-2">
                    {publishResult.success ? (
                      <>
                        <svg className="w-5 h-5 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        <span className="text-accent-green font-medium">Published Successfully!</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-5 h-5 text-accent-red" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        <span className="text-accent-red font-medium">Publish Failed</span>
                      </>
                    )}
                  </div>

                  {publishResult.url && (
                    <div className="flex items-center gap-2 mb-2">
                      <span className="flex-1 text-accent-blue text-sm truncate font-mono" title={publishResult.url}>
                        {publishResult.url}
                      </span>
                      <button
                        onClick={() => window.open(publishResult.url, '_blank')}
                        className="p-1.5 bg-accent-blue/20 hover:bg-accent-blue/80/30 rounded text-accent-blue transition-colors flex-shrink-0"
                        title="Open in new tab"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(publishResult.url!);
                          toast.success('URL copied to clipboard!');
                        }}
                        className="p-1.5 rounded flex-shrink-0"
                        style={getReviewActionButtonStyle({ tone: 'neutral' })}
                        title="Copy URL"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                    </div>
                  )}

                  {publishResult.error && (
                    <>
                      <p className="text-sm text-accent-red/70">{publishResult.error}</p>
                      {onOpenGlobalSettingsSection && /vercel|token|unauthorized|forbidden|401|403/i.test(publishResult.error) && (
                        <button
                          onClick={() => {
                            onClose();
                            onOpenGlobalSettingsSection('cloud');
                          }}
                          className="mt-2 flex items-center gap-2"
                          style={getReviewActionButtonStyle({ tone: 'purple', active: true })}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          Configure Vercel
                        </button>
                      )}
                    </>
                  )}

                  {publishResult.logs && (
                    <div className="mt-2">
                      <button
                        onClick={() => setShowLogs(!showLogs)}
                        className="flex items-center gap-1 text-xs"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <svg
                          className={`w-3 h-3 transition-transform ${showLogs ? 'rotate-90' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        View Logs
                      </button>
                      {showLogs && (
                        <pre className="mt-2 text-xs whitespace-pre-wrap break-words font-mono rounded p-2 max-h-48 overflow-y-auto" style={{ background: 'var(--review-code-bg)', color: 'var(--text-primary)', border: '1px solid var(--review-shell-border)' }}>
                          {publishResult.logs}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="text-center text-accent-red py-8">
              Failed to load publish status
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-header-bg)' }}>
          <button
            onClick={onClose}
            style={getReviewActionButtonStyle({ tone: 'neutral' })}
          >
            Close
          </button>
          {/* Gate publish button using selected changeset's verification status */}
          {/* Hide this button when Atlas Hosting is enabled - use that instead */}
          {(() => {
            // If Atlas Hosting is enabled, that's the primary deployment method
            // Don't show the external publish button (Vercel/script) to avoid confusion
            if (atlasHostingStatus?.enabled) return false;
            if (desktopNeedsVercelSetup) return false;

            const selected = status?.eligibleChangesets?.find(cs => cs.id === selectedChangesetId);
            if (!selected) return false;

            const hasAutomatedMethod = status?.publishMethod?.method !== 'manual';
            if (!hasAutomatedMethod) return false;

            // 'verified' status means all checks passed
            if (selected.status === 'verified') return true;

            // For 'applied' or 'committed', validate verification against available checks
            const availableChecks = status?.availableChecks;
            const verification = selected.verification;

            // Use structured checks if available, fall back to legacy booleans
            const checks = (availableChecks?.checks || []).filter((c) => c.enabled !== false);
            if (checks.length > 0) {
              for (const check of checks) {
                const checkStatus = verification?.checks?.[check.id]?.status
                  || (check.kind === 'lint' ? verification?.lint : undefined)
                  || (check.kind === 'unit' ? verification?.unit : undefined)
                  || (check.kind === 'e2e' ? verification?.e2e : undefined)
                  || 'not_run';
                if (checkStatus !== 'pass') return false;
              }
              return true;
            }

            // Legacy fallback: no structured checks configured
            if (!availableChecks?.lint && !availableChecks?.unit && !availableChecks?.e2e) {
              return ['applied', 'verified', 'committed'].includes(selected.status);
            }
            if (availableChecks?.lint && verification?.lint !== 'pass') return false;
            if (availableChecks?.unit && verification?.unit !== 'pass') return false;
            if (availableChecks?.e2e && verification?.e2e !== 'pass') return false;

            return true;
          })() && (
            <button
              onClick={handlePublish}
              disabled={isPublishing}
              className="flex items-center gap-2"
              style={getReviewActionButtonStyle({ tone: 'purple', active: true, disabled: isPublishing })}
            >
              {isPublishing ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Publishing...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  Publish
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default PublishPanel;
