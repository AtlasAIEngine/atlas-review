/**
 * GitHub Panel Component
 * Comprehensive GitHub integration panel with:
 * - Connection status
 * - Repository browser
 * - Sync status indicator
 * - Sync history
 * - Manual sync triggers
 */

import { useState, useEffect } from 'react';
import GitHubConnect from './GitHubConnect';
import RepositoryBrowser from './RepositoryBrowser';
import githubApi, {
  type GitHubInstallation,
  type ProjectSyncStatusResponse,
  type SyncHistoryResponse,
} from '@/services/githubApi';
import type { Project } from '@/types';
import { usePopup } from './shared/PopupProvider';
import { getReviewActionButtonStyle, getReviewToneVars } from './review/ReviewChrome';

interface GitHubPanelProps {
  currentProject: Project | null;
  onRepositoryCloned: (project: Project) => void;
}

type SyncStatus = ProjectSyncStatusResponse;
type SyncHistoryItem = SyncHistoryResponse['history'][number];

export default function GitHubPanel({ currentProject, onRepositoryCloned }: GitHubPanelProps) {
  const popup = usePopup();
  const [installation, setInstallation] = useState<GitHubInstallation | null>(null);
  const [allInstallations, setAllInstallations] = useState<GitHubInstallation[]>([]);
  const [showRepositoryBrowser, setShowRepositoryBrowser] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncHistory, setSyncHistory] = useState<SyncHistoryItem[]>([]);
  const [loadingSyncStatus, setLoadingSyncStatus] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [syncingNow, setSyncingNow] = useState<'push' | 'pull' | null>(null);
  const activeLifecycle = syncStatus?.lifecycle?.current || null;
  const syncBlockedReason = activeLifecycle
    ? activeLifecycle.reason
      || (activeLifecycle.state === 'retrying'
        ? 'Retry is scheduled'
        : activeLifecycle.state === 'queued'
          ? 'A sync job is queued'
          : 'A sync job is in progress')
    : null;

  // Clear sync status when GitHub is disconnected
  useEffect(() => {
    if (!installation) {
      setSyncStatus(null);
      setSyncHistory([]);
    }
  }, [installation]);

  // Load sync status and history when project changes
  useEffect(() => {
    if (currentProject) {
      loadSyncStatus();
      loadSyncHistory();

      // Auto-refresh sync status every 5 seconds if there's an active job
      const interval = setInterval(() => {
        if (syncStatus?.currentJob) {
          loadSyncStatus();
          loadSyncHistory();
        }
      }, 5000);

      return () => clearInterval(interval);
    }
  }, [currentProject, syncStatus?.currentJob]);

  const loadSyncStatus = async () => {
    if (!currentProject) return;

    try {
      setLoadingSyncStatus(true);
      const status = await githubApi.getProjectSyncStatus(currentProject.id);
      setSyncStatus(status);
    } catch (error: any) {
      console.error('Failed to load sync status:', error);
      // Don't show error if project doesn't have GitHub sync enabled
      if (error.response?.status !== 404) {
        console.error('Sync status error:', error);
      }
    } finally {
      setLoadingSyncStatus(false);
    }
  };

  const loadSyncHistory = async () => {
    if (!currentProject) return;

    try {
      setLoadingHistory(true);
      const result = await githubApi.getSyncHistory(currentProject.id, 10);
      setSyncHistory(result.history);
    } catch (error: any) {
      console.error('Failed to load sync history:', error);
      // Don't show error if project doesn't have sync history
      if (error.response?.status !== 404) {
        console.error('Sync history error:', error);
      }
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleManualSync = async (type: 'push' | 'pull') => {
    if (!currentProject || syncingNow) return;

    try {
      setSyncingNow(type);
      await githubApi.triggerSync(currentProject.id, type);

      // Refresh status and history immediately
      await loadSyncStatus();
      await loadSyncHistory();
    } catch (error: any) {
      console.error(`Failed to trigger ${type} sync:`, error);
      await popup.alert({
        title: 'Sync Failed',
        message: error.response?.data?.error || `Failed to trigger ${type} sync.`,
        danger: true,
      });
    } finally {
      setSyncingNow(null);
    }
  };

  const getSyncStatusColor = (status: string) => {
    const green = getReviewToneVars('green');
    const blue = getReviewToneVars('blue');
    const red = getReviewToneVars('red');
    const neutral = getReviewToneVars('neutral');
    switch (status) {
      case 'synced':
        return { background: green.bg, color: green.text, border: `1px solid ${green.border}` };
      case 'syncing':
        return { background: blue.bg, color: blue.text, border: `1px solid ${blue.border}` };
      case 'error':
        return { background: red.bg, color: red.text, border: `1px solid ${red.border}` };
      case 'disabled':
        return { background: neutral.bg, color: neutral.text, border: `1px solid ${neutral.border}` };
      default:
        return { background: neutral.bg, color: neutral.text, border: `1px solid ${neutral.border}` };
    }
  };

  const getSyncStatusIcon = (status: string) => {
    switch (status) {
      case 'synced':
        return '✓';
      case 'syncing':
        return '↻';
      case 'error':
        return '✗';
      default:
        return '○';
    }
  };

  const getJobStatusBadge = (status: string) => {
    const green = getReviewToneVars('green');
    const red = getReviewToneVars('red');
    const blue = getReviewToneVars('blue');
    const yellow = getReviewToneVars('yellow');
    const neutral = getReviewToneVars('neutral');
    switch (status) {
      case 'completed':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full" style={{ background: green.bg, color: green.text, border: `1px solid ${green.border}` }}>✓ Completed</span>;
      case 'failed':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full" style={{ background: red.bg, color: red.text, border: `1px solid ${red.border}` }}>✗ Failed</span>;
      case 'processing':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full animate-pulse" style={{ background: blue.bg, color: blue.text, border: `1px solid ${blue.border}` }}>↻ Processing</span>;
      case 'pending':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full" style={{ background: yellow.bg, color: yellow.text, border: `1px solid ${yellow.border}` }}>⋯ Pending</span>;
      default:
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full" style={{ background: neutral.bg, color: neutral.text, border: `1px solid ${neutral.border}` }}>{status}</span>;
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  // If repository browser is showing, render it
  if (showRepositoryBrowser && installation) {
    return (
      <RepositoryBrowser
        installation={installation}
        installations={allInstallations}
        onCloned={onRepositoryCloned}
        onClose={() => setShowRepositoryBrowser(false)}
      />
    );
  }

  return (
    <div className="h-full overflow-auto" style={{ background: 'var(--review-shell-bg)' }}>
      <div className="p-6 space-y-6">
        {/* GitHub Connection Status */}
        <GitHubConnect
          currentProject={currentProject ? { id: currentProject.id, name: currentProject.name } : null}
          onConnected={(inst) => {
            setInstallation(inst);
            githubApi.getInstallations().then(all => setAllInstallations(all)).catch(() => {});
          }}
          onRepositoriesClick={() => setShowRepositoryBrowser(true)}
          onProjectConnected={loadSyncStatus}
        />

        {/* Sync Status Card - Only show if project has GitHub sync enabled */}
        {currentProject && syncStatus?.syncEnabled && (
          <div style={{ background: 'var(--review-panel-bg)', border: '1px solid var(--review-shell-border)', borderRadius: 18, boxShadow: 'var(--review-panel-shadow)' }}>
            <div className="p-4" style={{ borderBottom: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-header-bg)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Sync Status</h3>
                  <span className="px-2 py-1 text-xs font-medium rounded-full" style={getSyncStatusColor(syncStatus.status)}>
                    {getSyncStatusIcon(syncStatus.status)} {syncStatus.status}
                  </span>
                </div>
                <button
                  onClick={() => {
                    loadSyncStatus();
                    loadSyncHistory();
                  }}
                  className="text-sm"
                  style={{ color: 'var(--accent-blue)' }}
                  disabled={loadingSyncStatus || loadingHistory}
                >
                  {loadingSyncStatus || loadingHistory ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>

            <div className="p-4 space-y-3">
              {/* Repository Info */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>Repository:</span>
                  <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{syncStatus.repository || 'N/A'}</p>
                </div>
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>Branch:</span>
                  <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{syncStatus.branch || 'N/A'}</p>
                </div>
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>Last Sync:</span>
                  <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {syncStatus.lastSyncAt ? formatDate(syncStatus.lastSyncAt) : 'Never'}
                  </p>
                </div>
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>Webhook:</span>
                  <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                    {syncStatus.webhookConfigured ? '✓ Configured' : '✗ Not configured'}
                  </p>
                </div>
              </div>

              {/* Current Job */}
              {syncStatus.currentJob && (
                <div className="mt-4 p-3 rounded-lg" style={{ background: 'var(--chip-info-bg)', border: '1px solid var(--chip-info-border)' }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {syncStatus.currentJob.type === 'push' ? '↑ Pushing' : '↓ Pulling'} changes...
                      </p>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                        Started {formatDate(syncStatus.currentJob.startedAt || syncStatus.currentJob.createdAt || new Date().toISOString())}
                      </p>
                    </div>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-accent-blue"></div>
                  </div>
                </div>
              )}

              {/* Manual Sync Buttons */}
              <div className="flex items-center space-x-3 pt-3" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                <button
                  onClick={() => handleManualSync('push')}
                  disabled={!!syncingNow || !!syncStatus.currentJob}
                  className="flex-1 flex items-center justify-center space-x-2"
                  style={{ ...getReviewActionButtonStyle({ tone: 'blue', active: true, disabled: !!syncingNow || !!syncStatus.currentJob }), minHeight: 40, borderRadius: 12 }}
                >
                  {syncingNow === 'push' ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-content"></div>
                      <span>Pushing...</span>
                    </>
                  ) : (
                    <>
                      <span>↑</span>
                      <span>Push to GitHub</span>
                    </>
                  )}
                </button>
                <button
                  onClick={() => handleManualSync('pull')}
                  disabled={!!syncingNow || !!syncStatus.currentJob}
                  className="flex-1 flex items-center justify-center space-x-2"
                  style={{ ...getReviewActionButtonStyle({ tone: 'green', active: true, disabled: !!syncingNow || !!syncStatus.currentJob }), minHeight: 40, borderRadius: 12 }}
                >
                  {syncingNow === 'pull' ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-content"></div>
                      <span>Pulling...</span>
                    </>
                  ) : (
                    <>
                      <span>↓</span>
                      <span>Pull from GitHub</span>
                    </>
                  )}
                </button>
              </div>
              {syncBlockedReason && (
                <p className="text-xs text-amber-700">{syncBlockedReason}</p>
              )}
            </div>
          </div>
        )}

        {/* Sync History Card - Only show if there's history */}
        {currentProject && syncHistory.length > 0 && (
          <div style={{ background: 'var(--review-panel-bg)', border: '1px solid var(--review-shell-border)', borderRadius: 18, boxShadow: 'var(--review-panel-shadow)' }}>
            <div className="p-4" style={{ borderBottom: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-header-bg)' }}>
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Sync History</h3>
            </div>

            <div style={{ borderTop: '1px solid transparent' }}>
              {syncHistory.map((item) => (
                <div key={item.id} className="p-4" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center space-x-2">
                        <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {item.type === 'push' ? '↑ Push' : '↓ Pull'}
                        </span>
                        {getJobStatusBadge(item.status)}
                        {item.duration && (
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            ({formatDuration(item.duration)})
                          </span>
                        )}
                      </div>

                      {item.commitMessage && (
                        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{item.commitMessage}</p>
                      )}

                      {item.commitSha && (
                        <p className="text-xs mt-1 font-mono" style={{ color: 'var(--text-tertiary)' }}>
                          {item.commitSha.substring(0, 7)}
                        </p>
                      )}

                      {item.filesChanged && item.filesChanged.length > 0 && (
                        <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                          {item.filesChanged.length} file{item.filesChanged.length !== 1 ? 's' : ''} changed
                        </p>
                      )}

                      {item.errorMessage && (
                        <p className="text-xs text-accent-red mt-1">Error: {item.errorMessage}</p>
                      )}
                    </div>

                    <div className="text-right ml-4">
                      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{formatDate(item.createdAt)}</p>
                      {item.retryCount > 0 && (
                        <p className="text-xs mt-1" style={{ color: 'var(--accent-yellow)' }}>
                          Retry {item.retryCount}/3
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {syncHistory.length >= 10 && (
              <div className="p-3 text-center" style={{ background: 'var(--review-panel-header-bg)', borderTop: '1px solid var(--review-shell-divider)' }}>
                <button
                  onClick={loadSyncHistory}
                  className="text-sm"
                  style={{ color: 'var(--accent-blue)' }}
                >
                  Load more
                </button>
              </div>
            )}
          </div>
        )}

        {/* No Sync Info Message */}
        {currentProject && !syncStatus?.syncEnabled && !loadingSyncStatus && !installation && (
          <div className="p-4 rounded-lg" style={{ background: 'var(--chip-warning-bg)', border: '1px solid var(--chip-warning-border)' }}>
            <p className="text-sm" style={{ color: 'var(--accent-yellow)' }}>
              This project is not linked to a GitHub repository. Clone a repository from GitHub or create a new one to enable automatic sync.
            </p>
          </div>
        )}
      </div>

    </div>
  );
}
