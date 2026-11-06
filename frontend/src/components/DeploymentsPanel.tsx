/**
 * DeploymentsPanel Component
 * View-only panel showing deployment history with production indicator
 * Supports promoting previous deployments to production (rollback)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { atlasHostingApi } from '../services/api';
import * as deployApi from '../services/deployApi';
import type { DeploymentsResponse, DeploymentRow } from '../types';
import type { DeploymentListItem } from '../services/deployApi';
import toast from '@/lib/toast';

interface DeploymentsPanelProps {
  projectId: string;
}

interface PromoteModalState {
  isOpen: boolean;
  deployment: DeploymentRow | null;
  isPromoting: boolean;
  logs: string;
  isRollback: boolean;
  status: 'idle' | 'running' | 'success' | 'error';
  errorMessage: string | null;
  showLogs: boolean;
}

function DeploymentsPanel({ projectId }: DeploymentsPanelProps) {
  const promoteCleanupRef = useRef<(() => void) | null>(null);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DeploymentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOnlyLatestPerCS, setShowOnlyLatestPerCS] = useState(true); // Default ON per P1.6
  const [promoteModal, setPromoteModal] = useState<PromoteModalState>({
    isOpen: false,
    deployment: null,
    isPromoting: false,
    logs: '',
    isRollback: false,
    status: 'idle',
    errorMessage: null,
    showLogs: false,
  });

  // Cloud deployments state
  const [cloudDeployments, setCloudDeployments] = useState<DeploymentListItem[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);

  const loadCloudDeployments = useCallback(async () => {
    setCloudLoading(true);
    try {
      const result = await deployApi.list();
      setCloudDeployments(result.data);
    } catch {
      // Cloud API may not be configured — silently ignore
      setCloudDeployments([]);
    } finally {
      setCloudLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDeployments();
    loadCloudDeployments();
  }, [projectId, loadCloudDeployments]);

  const loadDeployments = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await atlasHostingApi.getDeployments(projectId);
      setData(response);
    } catch (err: any) {
      console.error('Failed to load deployments:', err);
      setError(err.response?.data?.error || 'Failed to load deployments');
    } finally {
      setLoading(false);
    }
  };

  // Find the current production deployment's finish time (for Rollback vs Promote comparison)
  const getProductionDeploymentTime = (): number | null => {
    if (!data?.deployments) return null;
    // Find deployment marked as production
    const prodDeployment = data.deployments.find(d => d.isProduction);
    if (prodDeployment?.finishedAt) {
      return new Date(prodDeployment.finishedAt).getTime();
    }
    return null;
  };

  const openPromoteModal = (deployment: DeploymentRow) => {
    // Determine if this is a rollback (target is older than current production deployment)
    let isRollback = false;
    const productionTime = getProductionDeploymentTime();
    if (productionTime && deployment.finishedAt) {
      const targetTime = new Date(deployment.finishedAt).getTime();
      isRollback = targetTime < productionTime;
    }

    setPromoteModal({
      isOpen: true,
      deployment,
      isPromoting: false,
      logs: '',
      isRollback,
      status: 'idle',
      errorMessage: null,
      showLogs: false,
    });
  };

  // Cleanup promote SSE on unmount
  useEffect(() => {
    return () => {
      promoteCleanupRef.current?.();
      promoteCleanupRef.current = null;
    };
  }, []);

  const closePromoteModal = () => {
    // Can only close if not actively promoting (running state)
    if (promoteModal.status !== 'running') {
      promoteCleanupRef.current?.();
      promoteCleanupRef.current = null;
      setPromoteModal({
        isOpen: false,
        deployment: null,
        isPromoting: false,
        logs: '',
        isRollback: false,
        status: 'idle',
        errorMessage: null,
        showLogs: false,
      });
    }
  };

  const handlePromote = async () => {
    if (!promoteModal.deployment) return;

    // Clean up any previous promote stream
    promoteCleanupRef.current?.();
    promoteCleanupRef.current = null;

    setPromoteModal((prev) => ({
      ...prev,
      isPromoting: true,
      logs: '',
      status: 'running',
      errorMessage: null,
    }));

    const deploymentId = promoteModal.deployment.id;

    // Use SSE for streaming logs
    const cleanup = atlasHostingApi.subscribeToPromoteEvents(
      projectId,
      deploymentId,
      {
        onLog: (text) => {
          setPromoteModal((prev) => ({ ...prev, logs: prev.logs + text }));
        },
        onComplete: async () => {
          promoteCleanupRef.current?.();
          promoteCleanupRef.current = null;
          // Show success state in modal (don't auto-close)
          setPromoteModal((prev) => ({
            ...prev,
            isPromoting: false,
            status: 'success',
          }));
          // Refresh deployments to show updated production status
          await loadDeployments();
        },
        onError: (errorMsg) => {
          promoteCleanupRef.current?.();
          promoteCleanupRef.current = null;
          setPromoteModal((prev) => ({
            ...prev,
            isPromoting: false,
            status: 'error',
            errorMessage: errorMsg || 'Failed to update production alias',
          }));
        },
      }
    );

    promoteCleanupRef.current = cleanup;
  };

  const canPromote = (deployment: DeploymentRow): boolean => {
    // Can promote if: successful, has a vercel URL, and is not already production
    return (
      deployment.status === 'succeeded' &&
      !!deployment.vercelUrl &&
      !deployment.isProduction
    );
  };

  // Determine if promoting this deployment would be a rollback
  const getActionLabel = (deployment: DeploymentRow): 'Rollback' | 'Promote' => {
    const productionTime = getProductionDeploymentTime();
    if (!productionTime || !deployment.finishedAt) {
      return 'Promote';
    }
    const targetTime = new Date(deployment.finishedAt).getTime();
    return targetTime < productionTime ? 'Rollback' : 'Promote';
  };

  // Count changesets between two deployments (for "What will change?" display)
  const getChangesetsBetween = (targetDeployment: DeploymentRow): number => {
    if (!data?.deployments || !data?.production.deploymentId) return 0;

    const prodIndex = data.deployments.findIndex(d => d.deploymentId === data.production.deploymentId);
    const targetIndex = data.deployments.findIndex(d => d.id === targetDeployment.id);

    if (prodIndex === -1 || targetIndex === -1) return 0;

    // Count unique changesets between the two indices
    const start = Math.min(prodIndex, targetIndex);
    const end = Math.max(prodIndex, targetIndex);
    const changesetIds = new Set<string>();

    for (let i = start; i <= end; i++) {
      if (data.deployments[i].changesetId) {
        changesetIds.add(data.deployments[i].changesetId!);
      }
    }

    // Subtract 1 to not count the current production changeset
    return Math.max(0, changesetIds.size - 1);
  };

  // Filter deployments to show only latest per changeset if toggle is on
  const getFilteredDeployments = () => {
    if (!data || !showOnlyLatestPerCS) return data?.deployments || [];

    const latestPerCS = new Map<string, DeploymentRow>();
    for (const deployment of data.deployments) {
      const key = deployment.changesetId || deployment.id; // Use deployment id if no changeset
      if (!latestPerCS.has(key)) {
        latestPerCS.set(key, deployment);
      }
    }
    return Array.from(latestPerCS.values());
  };

  const formatRelativeTime = (timestamp: string | null): string => {
    if (!timestamp) return 'Unknown';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const formatAbsoluteTime = (timestamp: string | null): string => {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp).toLocaleString();
  };

  const formatDuration = (seconds: number | null): string => {
    if (seconds === null) return '';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const getStatusDisplay = (deployment: DeploymentRow) => {
    switch (deployment.status) {
      case 'succeeded':
        return {
          icon: (
            <svg className="w-4 h-4 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ),
          label: 'Ready',
          color: 'text-accent-green',
        };
      case 'failed':
        return {
          icon: (
            <svg className="w-4 h-4 text-accent-red" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ),
          label: 'Failed',
          color: 'text-accent-red',
        };
      case 'running':
        return {
          icon: (
            <svg className="w-4 h-4 text-accent-blue animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          ),
          label: 'Building',
          color: 'text-accent-blue',
        };
      case 'queued':
        return {
          icon: (
            <svg className="w-4 h-4 text-content-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ),
          label: 'Queued',
          color: 'text-content-secondary',
        };
      case 'canceled':
        return {
          icon: (
            <svg className="w-4 h-4 text-content-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          ),
          label: 'Canceled',
          color: 'text-content-secondary',
        };
      default:
        return { icon: null, label: 'Unknown', color: 'text-content-secondary' };
    }
  };

  const truncateUrl = (url: string, maxLength = 40) => {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + '...';
  };

  const truncateError = (error: string | null, maxLength = 60) => {
    if (!error) return null;
    if (error.length <= maxLength) return error;
    return error.substring(0, maxLength - 3) + '...';
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-base text-content-secondary">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue mb-3" />
          <p>Loading deployments...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-base text-content-secondary">
        <div className="text-center">
          <p className="text-accent-red mb-3">{error}</p>
          <button
            onClick={loadDeployments}
            className="px-4 py-2 bg-accent-blue hover:bg-accent-blue/80 text-content rounded"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data || data.deployments.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-base text-content-secondary">
        <div className="text-center">
          <svg className="w-16 h-16 mx-auto mb-4 text-content-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <p className="text-lg mb-2">No Deployments Yet</p>
          <p className="text-sm">Deploy your first changeset to see it here</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-base overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-content">Deployments</h2>
            <p className="text-sm text-content-secondary mt-1">View deployment history and production status</p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showOnlyLatestPerCS}
              onChange={(e) => setShowOnlyLatestPerCS(e.target.checked)}
              className="w-4 h-4 rounded border-border-strong bg-surface-elevated text-accent-blue focus:ring-accent-blue focus:ring-offset-surface"
            />
            <span className="text-sm text-content-secondary">Latest per changeset</span>
          </label>
        </div>
      </div>

      {/* Production Banner */}
      {data.production.url && (
        <div className="mx-4 mt-4 p-4 bg-accent-green/10 border border-accent-green/30 rounded-lg">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-2 h-2 bg-accent-green rounded-full animate-pulse" />
                <h3 className="text-sm font-semibold text-accent-green">Current Production</h3>
                <span className="px-2 py-0.5 bg-accent-green/20 text-accent-green text-xs rounded">
                  Alias URL
                </span>
              </div>
              <div className="space-y-1 text-sm">
                <p className="text-accent-blue font-mono text-sm">{data.production.url}</p>
                {(data.production.changesetDisplayId || data.production.changesetId) && (
                  <p className="text-content">
                    <span className="font-medium text-content">
                      {data.production.changesetDisplayId || data.production.changesetId}
                    </span>
                    {data.production.changesetTitle && (
                      <span className="text-content-secondary ml-2">{data.production.changesetTitle}</span>
                    )}
                  </p>
                )}
                {data.production.commitHash && (
                  <p className="text-content-tertiary text-xs font-mono">
                    commit {data.production.commitHash.substring(0, 7)}
                  </p>
                )}
                <p className="text-content-tertiary text-xs">
                  Last updated {formatRelativeTime(data.production.updatedAt)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1 ml-4">
              <a
                href={data.production.url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 bg-accent-green hover:bg-accent-green/80 text-content rounded transition-colors"
                title="Open live site"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
              <button
                onClick={() => copyToClipboard(data.production.url!)}
                className="p-2 bg-surface-elevated hover:bg-surface-hover text-content rounded transition-colors"
                title="Copy URL"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deployments Table */}
      <div className="flex-1 overflow-auto p-4 min-h-0">
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full table-fixed">
            <thead className="bg-surface-elevated border-b border-border">
              <tr>
                <th className="w-56 px-4 py-3 text-left text-xs font-medium text-content-secondary uppercase tracking-wider">Status</th>
                <th className="w-64 px-4 py-3 text-left text-xs font-medium text-content-secondary uppercase tracking-wider">Version</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-content-secondary uppercase tracking-wider">Snapshot</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-content-secondary uppercase tracking-wider w-44 min-w-[11rem]"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {getFilteredDeployments().map((deployment) => {
                const statusDisplay = getStatusDisplay(deployment);
                const snapshotUrl = deployment.vercelUrl || deployment.url;
                const isBeingPromoted = promoteModal.isPromoting && promoteModal.deployment?.id === deployment.id;

                return (
                  <tr
                    key={deployment.id}
                    className={`transition-colors ${
                      deployment.isProduction
                        ? 'bg-accent-green/10 border-l-2 border-l-accent-green'
                        : isBeingPromoted
                        ? 'bg-accent-blue/10 border-l-2 border-l-accent-blue'
                        : 'hover:bg-surface-hover border-l-2 border-l-transparent'
                    }`}
                  >
                    {/* Status Column */}
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          {statusDisplay.icon}
                          <span className={`text-sm font-medium ${statusDisplay.color}`}>
                            {statusDisplay.label}
                          </span>
                          {deployment.isProduction && (
                            <span className="px-2 py-0.5 rounded text-xs bg-accent-green text-content font-medium animate-pulse">
                              LIVE
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-content-tertiary">
                          <span title={formatAbsoluteTime(deployment.finishedAt || deployment.startedAt)}>
                            {formatRelativeTime(deployment.finishedAt || deployment.startedAt)}
                          </span>
                          {deployment.durationSeconds !== null && (
                            <span className="text-content-tertiary">({formatDuration(deployment.durationSeconds)})</span>
                          )}
                        </div>
                        {/* Error summary for failed deployments */}
                        {deployment.status === 'failed' && deployment.errorMessage && (
                          <div className="flex items-center gap-1 mt-1">
                            <span
                              className="text-xs text-accent-red truncate max-w-xs"
                              title={deployment.errorMessage}
                            >
                              {truncateError(deployment.errorMessage)}
                            </span>
                            {deployment.inspectUrl && (
                              <a
                                href={deployment.inspectUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-accent-blue hover:text-accent-blue/80 whitespace-nowrap"
                              >
                                View logs
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Version Column */}
                    <td className="w-64 px-4 py-3">
                      <div className="text-sm min-w-0">
                        {deployment.changesetDisplayId && (
                          <div className="text-content font-medium">{deployment.changesetDisplayId}</div>
                        )}
                        {deployment.changesetTitle && (
                          <div className="text-content-secondary text-xs truncate max-w-[14rem]" title={deployment.changesetTitle}>
                            {deployment.changesetTitle}
                          </div>
                        )}
                        {deployment.commitHash && (
                          <div className="text-content-tertiary text-xs font-mono">{deployment.commitHash.substring(0, 7)}</div>
                        )}
                      </div>
                    </td>

                    {/* Snapshot URL Column */}
                    <td className="px-4 py-3">
                      {snapshotUrl ? (
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="px-1.5 py-0.5 bg-surface-elevated text-content-secondary text-xs rounded shrink-0">
                            Snapshot
                          </span>
                          <a
                            href={snapshotUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block min-w-0 flex-1 text-sm text-accent-blue hover:text-accent-blue/80 font-mono truncate"
                            title={snapshotUrl}
                          >
                            {truncateUrl(snapshotUrl, 35)}
                          </a>
                        </div>
                      ) : (
                        <span className="text-content-tertiary text-sm">-</span>
                      )}
                    </td>

                    {/* Actions Column */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2 min-w-max">
                        {/* Show spinner if this row is being promoted */}
                        {isBeingPromoted ? (
                          <span className="flex items-center gap-1 text-accent-blue text-xs">
                            <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            {promoteModal.isRollback ? 'Rolling back...' : 'Promoting...'}
                          </span>
                        ) : (
                          <>
                            {/* Promote/Rollback button - only for eligible deployments */}
                            {canPromote(deployment) && (
                              <button
                                onClick={() => openPromoteModal(deployment)}
                                disabled={promoteModal.isPromoting}
                                className={`px-2 py-1 text-content text-xs rounded transition-colors ${
                                  getActionLabel(deployment) === 'Rollback'
                                    ? 'bg-accent-orange hover:bg-accent-orange/80 disabled:bg-accent-orange/60'
                                    : 'bg-accent-yellow hover:bg-accent-yellow/80 disabled:bg-accent-yellow/60'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                                title={`${getActionLabel(deployment)} to this version`}
                              >
                                {getActionLabel(deployment)}
                              </button>
                            )}
                            {snapshotUrl && (
                              <>
                                <a
                                  href={snapshotUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-1 text-accent-blue hover:text-accent-blue/80 rounded hover:bg-surface-hover transition-colors"
                                  title="Open snapshot"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                  </svg>
                                </a>
                                <button
                                  onClick={() => copyToClipboard(snapshotUrl)}
                                  className="p-1 text-content-secondary hover:text-content rounded hover:bg-surface-hover transition-colors"
                                  title="Copy snapshot URL"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                  </svg>
                                </button>
                              </>
                            )}
                          </>
                        )}
                        {/* Build logs icon - always visible if available */}
                        {deployment.inspectUrl && (
                          <a
                            href={deployment.inspectUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-content-tertiary hover:text-content-secondary"
                            title="View build logs in Vercel"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cloud Deployments Section */}
      {cloudDeployments.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-content uppercase tracking-wide">
              Cloud Deployments
            </h3>
            <button
              onClick={loadCloudDeployments}
              className="text-xs text-content-tertiary hover:text-content transition-colors"
              disabled={cloudLoading}
            >
              {cloudLoading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
          <div className="space-y-2">
            {cloudDeployments.map((d) => {
              const isLive = d.status === 'live';
              const isExpired = d.status === 'expired';
              const expiresAt = d.expiresAt ? new Date(d.expiresAt) : null;
              const now = new Date();
              const daysLeft = expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / (86400000))) : null;

              return (
                <div
                  key={d.id}
                  className="flex items-center justify-between p-3 bg-surface/50 border border-border rounded-lg"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{
                        background: isLive ? 'var(--status-success)' : isExpired ? 'var(--status-error)' : 'var(--status-warning)',
                      }}
                    />
                    <div>
                      <div className="text-sm text-content font-medium">{d.projectName}</div>
                      <div className="text-xs text-content-tertiary">
                        {d.subdomain}.atlasengine.dev
                        {d.tier === 'free' && daysLeft !== null && isLive && (
                          <span className="ml-2 text-accent-yellow">{daysLeft}d left</span>
                        )}
                        {isExpired && <span className="ml-2 text-accent-red">Expired</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      d.tier === 'paid' ? 'bg-accent-blue/10 text-accent-blue' : 'bg-surface-elevated text-content-secondary'
                    }`}>
                      {d.tier}
                    </span>
                    {isLive && d.liveUrl && (
                      <a
                        href={d.liveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors"
                      >
                        Visit
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Promote/Rollback Confirmation Modal */}
      {promoteModal.isOpen && promoteModal.deployment && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface border border-border rounded-lg shadow-xl max-w-lg w-full mx-4">
            <div className="p-4 border-b border-border">
              <h3 className="text-lg font-semibold text-content">
                {promoteModal.status === 'success'
                  ? (promoteModal.isRollback ? 'Rollback Complete' : 'Promotion Complete')
                  : promoteModal.status === 'error'
                  ? (promoteModal.isRollback ? 'Rollback Failed' : 'Promotion Failed')
                  : promoteModal.status === 'running'
                  ? (promoteModal.isRollback ? 'Rolling back...' : 'Promoting...')
                  : (promoteModal.isRollback ? 'Rollback to Previous Version?' : 'Promote to Production?')
                }
              </h3>
            </div>
            <div className="p-4 space-y-4">
              {/* SUCCESS STATE */}
              {promoteModal.status === 'success' && (
                <>
                  <div className="flex items-center gap-3 text-accent-green">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <p className="font-medium">
                        Production now points to {promoteModal.deployment.changesetDisplayId || 'deployment'}
                        {promoteModal.deployment.commitHash && (
                          <span className="font-mono text-content-secondary text-sm ml-2">
                            ({promoteModal.deployment.commitHash.substring(0, 7)})
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-content-secondary">
                        The alias URL has been updated successfully.
                      </p>
                    </div>
                  </div>
                  {data?.production.url && (
                    <div className="bg-accent-green/10 border border-accent-green/30 rounded p-3">
                      <p className="text-accent-green font-mono text-sm break-all">
                        {data.production.url}
                      </p>
                    </div>
                  )}
                  {/* Collapsible logs */}
                  {promoteModal.logs && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-content-secondary hover:text-content">
                        View details
                      </summary>
                      <div className="mt-2 bg-surface-base rounded p-3 font-mono text-xs text-content-secondary max-h-32 overflow-y-auto whitespace-pre-wrap">
                        {promoteModal.logs}
                      </div>
                    </details>
                  )}
                </>
              )}

              {/* ERROR STATE */}
              {promoteModal.status === 'error' && (
                <>
                  <div className="flex items-center gap-3 text-accent-red">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <p className="font-medium">
                        {promoteModal.isRollback ? 'Rollback failed' : 'Promotion failed'}
                      </p>
                      <p className="text-sm text-content-secondary">
                        {promoteModal.errorMessage || 'An error occurred while updating the alias.'}
                      </p>
                    </div>
                  </div>
                  {/* Show logs for debugging */}
                  {promoteModal.logs && (
                    <details className="text-sm" open>
                      <summary className="cursor-pointer text-content-secondary hover:text-content">
                        View logs
                      </summary>
                      <div className="mt-2 bg-surface-base rounded p-3 font-mono text-xs text-content-secondary max-h-32 overflow-y-auto whitespace-pre-wrap">
                        {promoteModal.logs}
                      </div>
                    </details>
                  )}
                </>
              )}

              {/* RUNNING STATE */}
              {promoteModal.status === 'running' && (
                <>
                  <div className="flex items-center gap-3 text-accent-blue">
                    <svg className="w-6 h-6 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <span>Updating production alias...</span>
                  </div>
                  {/* Collapsible logs (collapsed by default) */}
                  <details className="text-sm" open={promoteModal.showLogs}>
                    <summary
                      className="cursor-pointer text-content-secondary hover:text-content"
                      onClick={(e) => {
                        e.preventDefault();
                        setPromoteModal((prev) => ({ ...prev, showLogs: !prev.showLogs }));
                      }}
                    >
                      {promoteModal.showLogs ? 'Hide details' : 'Show details'}
                    </summary>
                    {promoteModal.showLogs && promoteModal.logs && (
                      <div className="mt-2 bg-surface-base rounded p-3 font-mono text-xs text-content-secondary max-h-32 overflow-y-auto whitespace-pre-wrap">
                        {promoteModal.logs}
                      </div>
                    )}
                  </details>
                </>
              )}

              {/* IDLE STATE - Confirmation with Compare */}
              {promoteModal.status === 'idle' && (
                <>
                  {/* Version comparison table */}
                  <div className="bg-surface-base rounded overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-surface/50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs text-content-tertiary font-medium"></th>
                          <th className="px-3 py-2 text-left text-xs text-content-tertiary font-medium">Current</th>
                          <th className="px-3 py-2 text-left text-xs text-content-tertiary font-medium">
                            <span className={promoteModal.isRollback ? 'text-accent-orange' : 'text-accent-yellow'}>
                              {promoteModal.isRollback ? '← Rollback to' : 'Promote to →'}
                            </span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-muted">
                        <tr>
                          <td className="px-3 py-2 text-content-tertiary">Changeset</td>
                          <td className="px-3 py-2 text-content font-medium">
                            {data?.production.changesetDisplayId || '—'}
                          </td>
                          <td className="px-3 py-2 text-content font-medium">
                            {promoteModal.deployment.changesetDisplayId || '—'}
                          </td>
                        </tr>
                        <tr>
                          <td className="px-3 py-2 text-content-tertiary">Commit</td>
                          <td className="px-3 py-2 font-mono text-content-secondary text-xs">
                            {data?.production.commitHash?.substring(0, 7) || '—'}
                          </td>
                          <td className="px-3 py-2 font-mono text-content-secondary text-xs">
                            {promoteModal.deployment.commitHash?.substring(0, 7) || '—'}
                          </td>
                        </tr>
                        <tr>
                          <td className="px-3 py-2 text-content-tertiary">Title</td>
                          <td className="px-3 py-2 text-content-secondary text-xs truncate max-w-[140px]" title={data?.production.changesetTitle || ''}>
                            {data?.production.changesetTitle || '—'}
                          </td>
                          <td className="px-3 py-2 text-content-secondary text-xs truncate max-w-[140px]" title={promoteModal.deployment.changesetTitle || ''}>
                            {promoteModal.deployment.changesetTitle || '—'}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* What will change? */}
                  {(() => {
                    const changesetCount = getChangesetsBetween(promoteModal.deployment);
                    if (changesetCount > 0) {
                      return (
                        <div className="text-sm text-content-secondary">
                          <span className="text-content-tertiary">Difference: </span>
                          <span className={promoteModal.isRollback ? 'text-accent-orange' : 'text-accent-yellow'}>
                            {changesetCount} changeset{changesetCount !== 1 ? 's' : ''} {promoteModal.isRollback ? 'back' : 'ahead'}
                          </span>
                        </div>
                      );
                    }
                    return null;
                  })()}

                  {/* Target snapshot - actionable */}
                  {promoteModal.deployment.vercelUrl && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-content-tertiary">Target snapshot:</span>
                      <span className="font-mono text-content-secondary truncate max-w-[200px]" title={promoteModal.deployment.vercelUrl}>
                        {truncateUrl(promoteModal.deployment.vercelUrl, 35)}
                      </span>
                      <a
                        href={promoteModal.deployment.vercelUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 text-accent-blue hover:text-accent-blue/80 rounded hover:bg-surface-hover transition-colors"
                        title="Open target snapshot (preview before switching)"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                      <button
                        onClick={() => copyToClipboard(promoteModal.deployment!.vercelUrl!)}
                        className="p-1 text-content-secondary hover:text-content rounded hover:bg-surface-hover transition-colors"
                        title="Copy snapshot URL"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                    </div>
                  )}

                  {/* Alias URL - the important one */}
                  {data?.production.url && (
                    <div className="bg-accent-green/10 border border-accent-green/30 rounded p-3">
                      <p className="text-xs text-accent-green uppercase tracking-wide mb-1">Alias URL (will be updated)</p>
                      <p className="text-accent-green font-mono text-sm break-all">
                        {data.production.url}
                      </p>
                    </div>
                  )}

                  {/* Info about alias switch mechanism */}
                  <div className={`rounded p-3 text-sm ${
                    promoteModal.isRollback
                      ? 'bg-accent-orange/10 border border-accent-orange/30 text-accent-orange'
                      : 'bg-accent-blue/10 border border-accent-blue/30 text-accent-blue'
                  }`}>
                    <p>
                      This will update the live alias to point to the target deployment. <strong>No rebuild required</strong> — the change is instant.
                    </p>
                  </div>
                </>
              )}
            </div>

            {/* Footer buttons - vary by state */}
            <div className="p-4 border-t border-border flex justify-end gap-3">
              {/* SUCCESS: Close + Open Live */}
              {promoteModal.status === 'success' && (
                <>
                  <button
                    onClick={closePromoteModal}
                    className="px-4 py-2 bg-surface-elevated hover:bg-surface-hover text-content rounded transition-colors"
                  >
                    Close
                  </button>
                  {data?.production.url && (
                    <a
                      href={data.production.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 bg-accent-green hover:bg-accent-green/80 text-content rounded transition-colors flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      Open Live Site
                    </a>
                  )}
                </>
              )}

              {/* ERROR: Close + Retry */}
              {promoteModal.status === 'error' && (
                <>
                  <button
                    onClick={closePromoteModal}
                    className="px-4 py-2 bg-surface-elevated hover:bg-surface-hover text-content rounded transition-colors"
                  >
                    Close
                  </button>
                  <button
                    onClick={handlePromote}
                    className="px-4 py-2 bg-accent-red hover:bg-accent-red/80 text-content rounded transition-colors flex items-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Retry
                  </button>
                </>
              )}

              {/* RUNNING: No cancel (operation in progress) */}
              {promoteModal.status === 'running' && (
                <button
                  disabled
                  className="px-4 py-2 bg-surface-elevated text-content-tertiary rounded cursor-not-allowed"
                >
                  Please wait...
                </button>
              )}

              {/* IDLE: Cancel + Promote/Rollback */}
              {promoteModal.status === 'idle' && (
                <>
                  <button
                    onClick={closePromoteModal}
                    className="px-4 py-2 bg-surface-elevated hover:bg-surface-hover text-content rounded transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handlePromote}
                    className={`px-4 py-2 text-content rounded transition-colors flex items-center gap-2 ${
                      promoteModal.isRollback
                        ? 'bg-accent-orange hover:bg-accent-orange/80'
                        : 'bg-accent-yellow hover:bg-accent-yellow/80'
                    }`}
                  >
                    {promoteModal.isRollback ? 'Rollback' : 'Promote'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DeploymentsPanel;
