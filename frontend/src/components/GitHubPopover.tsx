/**
 * GitHubPopover Component
 * Lovable-style popover showing GitHub connection status and quick actions.
 */

import { useState, useEffect, useCallback } from 'react';
import toast from '@/lib/toast';
import useGitStatus from '@/hooks/useGitStatus';
import useSyncStatus, { type SyncStatus } from '@/hooks/useSyncStatus';
import githubApi, { type GitHubInstallation } from '@/services/githubApi';
import { openExternal } from '@/utils/openExternal';
import useGitHubDeviceFlow from '@/hooks/useGitHubDeviceFlow';
import DeviceCodeDisplay from '@/components/DeviceCodeDisplay';
import { usePopup } from './shared/PopupProvider';
import { getReviewActionButtonStyle } from './review/ReviewChrome';
import { isTauriEnvironment } from '@/utils/tauri';

const isTauri = isTauriEnvironment();

// Helper to format relative time
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
}

function getSyncLifecycleTone(status: SyncStatus): 'info' | 'warning' | 'error' | 'success' {
  const lifecycleState = status.lifecycle?.state || status.lastOutcome?.state;
  if (lifecycleState === 'failed') return 'error';
  if (lifecycleState === 'superseded' || lifecycleState === 'retrying' || lifecycleState === 'queued') return 'warning';
  if (lifecycleState === 'completed') return 'success';
  return 'info';
}

// Sync status badge component
function SyncStatusBadge({ status }: { status: SyncStatus | null }) {
  if (!status) return null;

  const badges: Record<string, { bg: string; color: string; text: string }> = {
    synced: { bg: 'var(--chip-success-bg)', color: 'var(--accent-green)', text: 'Synced' },
    syncing: { bg: 'var(--chip-info-bg)', color: 'var(--accent-blue)', text: 'Syncing' },
    error: { bg: 'var(--chip-error-bg)', color: 'var(--accent-red)', text: 'Error' },
    disabled: { bg: 'rgba(110,118,129,0.12)', color: 'var(--text-tertiary)', text: 'Disabled' },
    idle: { bg: 'rgba(110,118,129,0.12)', color: 'var(--text-tertiary)', text: 'Idle' },
  };

  const badge = badges[status.status] || badges.idle;

  return (
    <span style={{
      padding: '2px var(--space-2)',
      borderRadius: 'var(--radius-sm)',
      fontSize: 'var(--text-xs)',
      fontWeight: 500,
      fontFamily: 'var(--font-sans)',
      background: badge.bg,
      color: badge.color,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}>
      {status.isSyncing && (
        <span className="animate-pulse" style={{
          width: 8,
          height: 8,
          background: 'var(--accent-blue)',
          borderRadius: 'var(--radius-full)',
        }} />
      )}
      {badge.text}
    </span>
  );
}

interface GitHubPopoverProps {
  projectId: string;
  projectName: string;
  isOpen: boolean;
  onClose: () => void;
}

type ProjectSyncStatus = Awaited<ReturnType<typeof githubApi.getProjectSyncStatus>>;

export default function GitHubPopover({
  projectId,
  projectName,
  isOpen,
  onClose,
}: GitHubPopoverProps) {
  const popup = usePopup();
  const { status: gitStatus, loading: gitLoading, refresh: refreshGit } = useGitStatus(projectId, {
    pollInterval: 5000,
    enablePolling: isOpen,
  });
  const { status: syncStatus } = useSyncStatus(projectId, { enabled: isOpen });

  const [installation, setInstallation] = useState<GitHubInstallation | null>(null);
  const [projectSync, setProjectSync] = useState<ProjectSyncStatus | null>(null);
  const [loadingInstall, setLoadingInstall] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  // Hover states for interactive elements
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);

  // Device flow hook
  const handleDeviceFlowConnected = useCallback((inst: GitHubInstallation) => {
    setInstallation(inst);
  }, []);

  const { connecting, deviceCode, connect: handleConnect, cancel: cancelDeviceFlow, loadInstallation } =
    useGitHubDeviceFlow({ onConnected: handleDeviceFlowConnected });

  // Connection status - tracks if repository access configuration is needed.
  const [connectStatus, setConnectStatus] = useState<{ step: string; url: string | null; message: string } | null>(null);

  // Create repo modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [repoName, setRepoName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [creating, setCreating] = useState(false);

  // Load GitHub installation, connection status, and project sync status
  useEffect(() => {
    if (!isOpen) return;

    const load = async () => {
      setLoadingInstall(true);
      await refreshGit().catch((err) => {
        console.error('Failed to refresh git status on open:', err);
      });

      const inst = await loadInstallation();
      if (inst) setInstallation(inst);

      // Check connection status (including token validity)
      try {
        const status = await githubApi.getConnectUrl();
        setConnectStatus(status);
      } catch (err) {
        console.error('Failed to check connection status:', err);
      }

      try {
        const sync = await githubApi.getProjectSyncStatus(projectId);
        setProjectSync(sync);
      } catch (err: any) {
        // 404 is expected if not linked
        if (err.response?.status !== 404) {
          console.error('Failed to load sync status:', err);
        }
      }

      setLoadingInstall(false);
    };

    load();
  }, [isOpen, projectId, loadInstallation, refreshGit]);

  // Initialize repo name from project name
  useEffect(() => {
    if (showCreateModal && !repoName) {
      setRepoName(sanitizeRepoName(projectName));
    }
  }, [showCreateModal, projectName]);

  const sanitizeRepoName = (name: string): string => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]/g, '-')
      .replace(/^[.\-_]+|[.\-_]+$/g, '')
      .replace(/[-_.]{2,}/g, '-')
      .substring(0, 100);
  };

  // Cancel device flow when popover closes
  useEffect(() => {
    if (!isOpen) {
      cancelDeviceFlow();
    }
  }, [isOpen, cancelDeviceFlow]);

  const handleInitGit = async () => {
    // TODO: Implement git init via backend API
    toast('Git initialization coming soon');
  };

  const handleCreateRepo = async () => {
    if (!repoName.trim()) {
      toast.error('Repository name is required');
      return;
    }

    setCreating(true);
    try {
      const result = await githubApi.createRepository(projectId, {
        name: repoName,
        private: isPrivate,
      });

      if (result.success) {
        toast.success(`Repository ${result.repository.fullName} created!`);
        setShowCreateModal(false);
        // Refresh statuses
        refreshGit();
        const sync = await githubApi.getProjectSyncStatus(projectId);
        setProjectSync(sync);
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to create repository');
    } finally {
      setCreating(false);
    }
  };

  const handlePush = async () => {
    setPushing(true);
    try {
      const result = await githubApi.triggerSync(projectId, 'push');
      if (result.success) {
        // Don't show toast - loading indicator is enough feedback
        // Keep pushing=true briefly to allow WebSocket to update syncStatus
        setTimeout(() => {
          setPushing(false);
          refreshGit();
        }, 1000);
        return; // Don't run finally block immediately
      }
    } catch (err: any) {
      if (err.response?.status === 401) {
        setConnectStatus({ step: 'reauthorize', url: null, message: 'GitHub token expired. Please reconnect.' });
      } else {
        toast.error(err.response?.data?.error || 'Push failed');
      }
    }
    setPushing(false);
  };

  const handlePull = async () => {
    setPulling(true);
    try {
      const result = await githubApi.triggerSync(projectId, 'pull');
      if (result.success) {
        // Don't show toast - loading indicator is enough feedback
        // Keep pulling=true briefly to allow WebSocket to update syncStatus
        setTimeout(() => {
          setPulling(false);
          refreshGit();
        }, 1000);
        return; // Don't run finally block immediately
      }
    } catch (err: any) {
      if (err.response?.status === 401) {
        setConnectStatus({ step: 'reauthorize', url: null, message: 'GitHub token expired. Please reconnect.' });
      } else {
        toast.error(err.response?.data?.error || 'Pull failed');
      }
    }
    setPulling(false);
  };

  const handleOpenOnGitHub = () => {
    if (gitStatus?.owner && gitStatus?.repo) {
      openExternal(`https://github.com/${gitStatus.owner}/${gitStatus.repo}`);
    } else if (projectSync?.repository) {
      openExternal(`https://github.com/${projectSync.repository}`);
    }
  };

  const handleCreatePR = () => {
    if (gitStatus?.owner && gitStatus?.repo && gitStatus?.branch) {
      const base = projectSync?.branch || 'main';
      const url = `https://github.com/${gitStatus.owner}/${gitStatus.repo}/compare/${base}...${gitStatus.branch}`;
      openExternal(url);
    }
  };

  const handleUnlink = async () => {
    const confirmed = await popup.confirm({
      title: 'Unlink Project from GitHub?',
      message:
        'This will remove the git remote but keep your local files in place. You can reconnect later.',
      confirmLabel: 'Unlink project',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) {
      return;
    }

    setUnlinking(true);
    try {
      await githubApi.unlinkProject(projectId);
      toast.success('Project unlinked from GitHub');
      // Reset state
      setProjectSync(null);
      setInstallation(null);
      refreshGit();
    } catch (err: any) {
      toast.error(err.response?.data?.error || 'Failed to unlink project');
    } finally {
      setUnlinking(false);
    }
  };

  if (!isOpen) return null;

  const isConnected = gitStatus?.isGitHub && projectSync?.syncEnabled;
  const isRepo = gitStatus?.isRepo;
  const hasRemote = !!gitStatus?.originUrl;
  const isLoading = gitLoading || loadingInstall;
  const activeLifecycle = syncStatus?.lifecycle || null;
  const syncBusyReason = activeLifecycle?.reason
    || (activeLifecycle?.state === 'retrying'
      ? 'Sync retry is scheduled.'
      : activeLifecycle?.state === 'queued'
        ? 'A sync job is queued.'
        : activeLifecycle?.state === 'processing'
          ? 'A sync job is currently running.'
          : null);

  const hasPushWork = Boolean(gitStatus?.dirty || (gitStatus?.ahead || 0) > 0);
  const pushDisabledReason = syncStatus?.isSyncing
    ? syncBusyReason
    : !gitStatus?.hasUpstream
      ? 'No upstream remote configured.'
      : !hasPushWork
        ? 'No local changes or commits to push.'
        : null;
  const pullDisabledReason = syncStatus?.isSyncing
    ? syncBusyReason
    : !gitStatus?.hasUpstream
      ? 'No upstream remote configured.'
      : null;
  const canPush = !pushing && !pushDisabledReason;
  const canPull = !pulling && !pullDisabledReason;

  // Shared styles
  const primaryBtnStyle: React.CSSProperties = {
    ...getReviewActionButtonStyle({ tone: 'blue', active: true }),
    borderRadius: 10,
    minHeight: 32,
    fontSize: 'var(--text-sm)',
    fontFamily: 'var(--font-sans)',
    fontWeight: 700,
    cursor: 'pointer',
    transition: `opacity var(--transition-fast)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-2)',
  };

  const secondaryBtnStyle: React.CSSProperties = {
    ...getReviewActionButtonStyle({ tone: 'neutral' }),
    borderRadius: 10,
    minHeight: 32,
    fontSize: 'var(--text-sm)',
    fontFamily: 'var(--font-sans)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    transition: `background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  };

  const ghostBtnStyle: React.CSSProperties = {
    ...getReviewActionButtonStyle({ tone: 'neutral' }),
    background: 'transparent',
    border: 'none',
    fontSize: 'var(--text-sm)',
    fontFamily: 'var(--font-sans)',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    transition: `color var(--transition-fast)`,
  };

  const destructiveBtnStyle: React.CSSProperties = {
    ...getReviewActionButtonStyle({ tone: 'red' }),
    background: 'transparent',
    borderRadius: 8,
    fontSize: 'var(--text-xs)',
    fontFamily: 'var(--font-sans)',
    color: 'var(--accent-red)',
    cursor: 'pointer',
    transition: `background var(--transition-fast)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-1)',
  };

  return (
    <>
      {/* Backdrop */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={onClose} />

      {/* Popover */}
      <div style={{
        position: 'absolute',
        right: 0,
        top: '100%',
        marginTop: 'var(--space-2)',
        width: 320,
        background: 'var(--review-shell-bg)',
        border: '1px solid var(--review-shell-border-strong)',
        borderRadius: 18,
        boxShadow: 'var(--review-panel-shadow)',
        zIndex: 50,
        fontFamily: 'var(--font-sans)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--review-shell-divider)',
          background: 'var(--review-panel-header-bg)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <svg style={{ width: 20, height: 20, color: 'var(--text-primary)' }} fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            <span style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 'var(--text-lg)' }}>GitHub</span>
          </div>
          {isConnected ? (
            <span style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 'var(--text-xs)',
              color: 'var(--accent-green)',
            }}>
              <span style={{
                width: 8,
                height: 8,
                background: 'var(--accent-green)',
                borderRadius: 'var(--radius-full)',
              }} />
              Connected
            </span>
          ) : (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>Not connected</span>
          )}
        </div>

        {/* Content */}
        <div style={{ padding: 'var(--space-4)', background: 'var(--review-panel-alt-bg)' }}>
          {isLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4) 0' }}>
              <div className="animate-spin" style={{
                borderRadius: 'var(--radius-full)',
                height: 20,
                width: 20,
                borderBottom: '2px solid var(--accent-blue)',
                borderTop: '2px solid transparent',
                borderLeft: '2px solid transparent',
                borderRight: '2px solid transparent',
              }} />
              <span style={{ marginLeft: 'var(--space-2)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>Loading...</span>
            </div>
          ) : !isRepo ? (
            /* Not a git repo */
            <div style={{ textAlign: 'center', padding: 'var(--space-2) 0' }}>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>This project is not a git repository.</p>
              <button
                onClick={handleInitGit}
                onMouseEnter={() => setHoveredBtn('initGit')}
                onMouseLeave={() => setHoveredBtn(null)}
                style={{
                  ...secondaryBtnStyle,
                  width: '100%',
                  padding: 'var(--space-2) var(--space-4)',
                  color: hoveredBtn === 'initGit' ? 'var(--text-primary)' : 'var(--text-secondary)',
                  borderColor: hoveredBtn === 'initGit' ? 'var(--review-shell-border-strong)' : 'var(--review-shell-border)',
                }}
              >
                Initialize Git
              </button>
            </div>
          ) : !installation ? (
            /* No GitHub account connected */
            <div style={{ textAlign: 'center', padding: 'var(--space-2) 0' }}>
              {connecting && deviceCode ? (
                <DeviceCodeDisplay deviceCode={deviceCode} variant="compact" />
              ) : (
                <>
                  <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>Connect your GitHub account to sync this project.</p>
                  <button
                    onClick={handleConnect}
                    disabled={connecting}
                    onMouseEnter={() => setHoveredBtn('connectGH')}
                    onMouseLeave={() => setHoveredBtn(null)}
                    style={{
                      ...primaryBtnStyle,
                      width: '100%',
                      padding: 'var(--space-2) var(--space-4)',
                      opacity: connecting ? 0.5 : hoveredBtn === 'connectGH' ? 0.85 : 1,
                    }}
                  >
                    <svg style={{ width: 16, height: 16 }} fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                    </svg>
                    {connecting ? 'Connecting...' : 'Connect GitHub'}
                  </button>
                </>
              )}
            </div>
          ) : connectStatus?.step === 'reauthorize' || connectStatus?.step === 'authorize' ? (
            /* Token expired or repository access missing */
            <div style={{ textAlign: 'center', padding: 'var(--space-2) 0' }}>
              <div style={{
                background: 'var(--chip-warning-bg)',
                border: '1px solid var(--chip-warning-border)',
                borderRadius: 'var(--radius-lg)',
                padding: 'var(--space-3)',
                marginBottom: 'var(--space-3)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--accent-orange)', marginBottom: 'var(--space-1)' }}>
                  <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>
                    {connectStatus.step === 'reauthorize' ? 'Reconnect GitHub' : 'Repository Access Required'}
                  </span>
                </div>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{connectStatus.message}</p>
              </div>
              {connecting && deviceCode ? (
                <DeviceCodeDisplay deviceCode={deviceCode} variant="compact" />
              ) : connectStatus.url ? (
                <button
                  onClick={() => {
                    if (isTauri) {
                      openExternal(connectStatus.url!);
                    } else {
                      window.open(connectStatus.url!, 'github-auth', 'width=800,height=600');
                    }
                  }}
                  onMouseEnter={() => setHoveredBtn('authorize')}
                  onMouseLeave={() => setHoveredBtn(null)}
                  style={{
                    ...primaryBtnStyle,
                    width: '100%',
                    padding: 'var(--space-2) var(--space-4)',
                    opacity: hoveredBtn === 'authorize' ? 0.85 : 1,
                  }}
                >
                  <svg style={{ width: 16, height: 16 }} fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                  Grant repository access
                </button>
              ) : (
                <button
                  onClick={() => {
                    setConnectStatus(null);
                    setInstallation(null);
                    handleConnect();
                  }}
                  disabled={connecting}
                  onMouseEnter={() => setHoveredBtn('reconnect')}
                  onMouseLeave={() => setHoveredBtn(null)}
                  style={{
                    ...primaryBtnStyle,
                    width: '100%',
                    padding: 'var(--space-2) var(--space-4)',
                    opacity: connecting ? 0.5 : hoveredBtn === 'reconnect' ? 0.85 : 1,
                  }}
                >
                  <svg style={{ width: 16, height: 16 }} fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                  Reconnect GitHub
                </button>
              )}
            </div>
          ) : !hasRemote || !isConnected ? (
            /* Has GitHub account but project not connected */
            <div style={{ textAlign: 'center', padding: 'var(--space-2) 0' }}>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>
                {hasRemote && !gitStatus?.isGitHub
                  ? 'Remote is not a GitHub repository.'
                  : 'Create a GitHub repository for this project.'}
              </p>
              <button
                onClick={() => setShowCreateModal(true)}
                onMouseEnter={() => setHoveredBtn('createRepo')}
                onMouseLeave={() => setHoveredBtn(null)}
                style={{
                  ...primaryBtnStyle,
                  width: '100%',
                  padding: 'var(--space-2) var(--space-4)',
                  opacity: hoveredBtn === 'createRepo' ? 0.85 : 1,
                }}
              >
                Create Repository
              </button>
              {/* TODO: Add "Connect to existing repo" option */}
            </div>
          ) : (
            /* Connected state - show repo info and actions */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              {/* Repo info */}
              <button
                onClick={handleOpenOnGitHub}
                onMouseEnter={() => setHoveredBtn('repoLink')}
                onMouseLeave={() => setHoveredBtn(null)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-2) var(--space-3)',
                  background: hoveredBtn === 'repoLink' ? 'var(--review-card-hover)' : 'var(--review-card-bg)',
                  borderRadius: 12,
                  transition: `background var(--transition-fast), border-color var(--transition-fast)`,
                  border: '1px solid var(--review-shell-border)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                <svg style={{ width: 16, height: 16, color: 'var(--text-tertiary)' }} fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
                <span style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-primary)',
                  flex: 1,
                  textAlign: 'left',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {gitStatus?.owner}/{gitStatus?.repo}
                </span>
                <svg style={{
                  width: 14,
                  height: 14,
                  color: hoveredBtn === 'repoLink' ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                  transition: `color var(--transition-fast)`,
                }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </button>

              {/* Branch + status */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <svg style={{ width: 16, height: 16, color: 'var(--text-tertiary)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  <span style={{ color: 'var(--text-secondary)' }}>{gitStatus?.branch}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-xs)' }}>
                  {gitStatus?.dirty ? (
                    <span style={{ color: 'var(--accent-yellow)' }}>&#9679; Modified</span>
                  ) : (
                    <span style={{ color: 'var(--accent-green)' }}>&#10003; Clean</span>
                  )}
                  {gitStatus?.hasUpstream && ((gitStatus.ahead ?? 0) > 0 || (gitStatus.behind ?? 0) > 0) && (
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      {(gitStatus.ahead ?? 0) > 0 && `\u2191${gitStatus.ahead}`}
                      {(gitStatus.behind ?? 0) > 0 && `\u2193${gitStatus.behind}`}
                    </span>
                  )}
                </div>
              </div>

              {/* Sync Status */}
              {syncStatus && syncStatus.status !== 'disabled' && (
                <div style={{
                  borderTop: '1px solid var(--review-shell-divider)',
                  paddingTop: 'var(--space-3)',
                  marginTop: 'var(--space-3)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>Sync Status</span>
                    <SyncStatusBadge status={syncStatus} />
                  </div>

                  {/* Last sync info */}
                  {syncStatus.lastSyncAt && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
                      Last synced {formatRelativeTime(syncStatus.lastSyncAt)}
                    </div>
                  )}

                  {(syncStatus.message || syncStatus.queue.total > 0) && (
                    <div style={{
                      marginTop: 'var(--space-2)',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${getSyncLifecycleTone(syncStatus) === 'error'
                        ? 'var(--chip-error-border)'
                        : getSyncLifecycleTone(syncStatus) === 'warning'
                          ? 'var(--chip-warning-border)'
                          : getSyncLifecycleTone(syncStatus) === 'success'
                            ? 'var(--chip-success-border)'
                            : 'var(--chip-info-border)'}`,
                      background: getSyncLifecycleTone(syncStatus) === 'error'
                        ? 'var(--chip-error-bg)'
                        : getSyncLifecycleTone(syncStatus) === 'warning'
                          ? 'var(--chip-warning-bg)'
                          : getSyncLifecycleTone(syncStatus) === 'success'
                            ? 'var(--chip-success-bg)'
                            : 'var(--chip-info-bg)',
                      padding: 'var(--space-2)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-1)',
                    }}>
                      {syncStatus.message && (
                        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-xs)' }}>
                          {syncStatus.message}
                        </span>
                      )}
                      {syncStatus.queue.total > 0 && (
                        <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>
                          Queue: {syncStatus.queue.processing} processing · {syncStatus.queue.retrying} retrying · {syncStatus.queue.queued} queued
                        </span>
                      )}
                    </div>
                  )}

                  {/* Error message */}
                  {syncStatus.error && (
                    <div style={{
                      background: 'var(--chip-error-bg)',
                      border: '1px solid var(--chip-error-border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 'var(--space-2)',
                      marginTop: 'var(--space-2)',
                    }}>
                      <span style={{ color: 'var(--accent-red)', fontSize: 'var(--text-xs)' }}>{syncStatus.error}</span>
                      {/* Show unlink option if repo not found */}
                      {syncStatus.error.includes('not found') && (
                        <button
                          onClick={handleUnlink}
                          disabled={unlinking}
                          onMouseEnter={() => setHoveredBtn('unlink')}
                          onMouseLeave={() => setHoveredBtn(null)}
                          style={{
                            ...destructiveBtnStyle,
                            marginTop: 'var(--space-2)',
                            width: '100%',
                            padding: '6px var(--space-2)',
                            opacity: unlinking ? 0.5 : 1,
                            background: hoveredBtn === 'unlink' ? 'rgba(248,81,73,0.15)' : 'transparent',
                          }}
                        >
                          {unlinking ? (
                            <div className="animate-spin" style={{
                              borderRadius: 'var(--radius-full)',
                              height: 12,
                              width: 12,
                              borderBottom: '2px solid var(--accent-red)',
                              borderTop: '2px solid transparent',
                              borderLeft: '2px solid transparent',
                              borderRight: '2px solid transparent',
                            }} />
                          ) : (
                            <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                            </svg>
                          )}
                          Unlink Project
                        </button>
                      )}
                    </div>
                  )}

                </div>
              )}

              {/* Conflict Warning */}
              {gitStatus?.dirty && (gitStatus?.behind || 0) > 0 && (
                <div style={{
                  background: 'var(--chip-warning-bg)',
                  border: '1px solid var(--chip-warning-border)',
                  borderRadius: 'var(--radius-lg)',
                  padding: 'var(--space-3)',
                  marginTop: 'var(--space-3)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <svg style={{ width: 20, height: 20, color: 'var(--accent-orange)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <span style={{ color: 'var(--accent-orange)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>
                      Potential Conflict
                    </span>
                  </div>
                  <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)', marginTop: 'var(--space-1)' }}>
                    You have local changes and the remote has {gitStatus.behind} new commit{(gitStatus.behind || 0) === 1 ? '' : 's'}.
                    Pull first to merge remote changes, then push your work.
                  </p>
                  <div style={{ marginTop: 'var(--space-2)' }}>
                    <button
                      onClick={handlePull}
                      disabled={!canPull}
                      onMouseEnter={() => setHoveredBtn('conflictPull')}
                      onMouseLeave={() => setHoveredBtn(null)}
                      style={{
                        width: '100%',
                        fontSize: 'var(--text-xs)',
                        padding: '6px var(--space-2)',
                        background: hoveredBtn === 'conflictPull' ? 'rgba(210,153,34,0.2)' : 'rgba(210,153,34,0.12)',
                        borderRadius: 'var(--radius-sm)',
                        color: 'var(--accent-orange)',
                        border: 'none',
                        cursor: !canPull ? 'not-allowed' : 'pointer',
                        opacity: !canPull ? 0.5 : 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 'var(--space-1)',
                        fontFamily: 'var(--font-sans)',
                        transition: `background var(--transition-fast)`,
                      }}
                    >
                      {pulling ? (
                        <div className="animate-spin" style={{
                          borderRadius: 'var(--radius-full)',
                          height: 12,
                          width: 12,
                          borderBottom: '2px solid var(--accent-orange)',
                          borderTop: '2px solid transparent',
                          borderLeft: '2px solid transparent',
                          borderRight: '2px solid transparent',
                        }} />
                      ) : (
                        <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 13l-5 5m0 0l-5-5m5 5V6" />
                        </svg>
                      )}
                      Pull & Merge
                    </button>
                  </div>
                </div>
              )}

              {/* Quick actions */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 'var(--space-2)',
                paddingTop: 'var(--space-2)',
              }}>
                <button
                  onClick={handlePush}
                  disabled={!canPush}
                  onMouseEnter={() => setHoveredBtn('push')}
                  onMouseLeave={() => setHoveredBtn(null)}
                  style={{
                    ...secondaryBtnStyle,
                    padding: 'var(--space-2) var(--space-3)',
                    opacity: !canPush ? 0.5 : 1,
                    cursor: !canPush ? 'not-allowed' : 'pointer',
                    color: hoveredBtn === 'push' && canPush
                      ? 'var(--text-primary)'
                      : 'var(--text-secondary)',
                    borderColor: hoveredBtn === 'push' && canPush
                      ? 'var(--review-shell-border-strong)'
                      : 'var(--review-shell-border)',
                  }}
                >
                  {pushing || (syncStatus?.isSyncing && syncStatus.currentJob?.type === 'push') ? (
                    <div className="animate-spin" style={{
                      borderRadius: 'var(--radius-full)',
                      height: 14,
                      width: 14,
                      borderBottom: '2px solid var(--text-secondary)',
                      borderTop: '2px solid transparent',
                      borderLeft: '2px solid transparent',
                      borderRight: '2px solid transparent',
                    }} />
                  ) : (
                    <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 11l5-5m0 0l5 5m-5-5v12" />
                    </svg>
                  )}
                  Push
                </button>
                <button
                  onClick={handlePull}
                  disabled={!canPull}
                  onMouseEnter={() => setHoveredBtn('pull')}
                  onMouseLeave={() => setHoveredBtn(null)}
                  style={{
                    ...secondaryBtnStyle,
                    padding: 'var(--space-2) var(--space-3)',
                    opacity: !canPull ? 0.5 : 1,
                    cursor: !canPull ? 'not-allowed' : 'pointer',
                    color: hoveredBtn === 'pull' && canPull
                      ? 'var(--text-primary)'
                      : 'var(--text-secondary)',
                    borderColor: hoveredBtn === 'pull' && canPull
                      ? 'var(--review-shell-border-strong)'
                      : 'var(--review-shell-border)',
                  }}
                >
                  {pulling || (syncStatus?.isSyncing && syncStatus.currentJob?.type === 'pull') ? (
                    <div className="animate-spin" style={{
                      borderRadius: 'var(--radius-full)',
                      height: 14,
                      width: 14,
                      borderBottom: '2px solid var(--text-secondary)',
                      borderTop: '2px solid transparent',
                      borderLeft: '2px solid transparent',
                      borderRight: '2px solid transparent',
                    }} />
                  ) : (
                    <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 13l-5 5m0 0l-5-5m5 5V6" />
                    </svg>
                  )}
                  Pull
                </button>
              </div>

              {(pushDisabledReason || pullDisabledReason) && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>
                  {pushDisabledReason || pullDisabledReason}
                </div>
              )}

              {/* Create PR */}
              {gitStatus?.hasUpstream && (gitStatus.ahead ?? 0) > 0 && (
                <button
                  onClick={handleCreatePR}
                  onMouseEnter={() => setHoveredBtn('createPR')}
                  onMouseLeave={() => setHoveredBtn(null)}
                  style={{
                    ...secondaryBtnStyle,
                    width: '100%',
                    padding: 'var(--space-2) var(--space-3)',
                    color: 'var(--accent-purple)',
                    borderColor: hoveredBtn === 'createPR'
                      ? 'var(--accent-purple)'
                      : 'var(--review-shell-border)',
                  }}
                >
                  <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                  Create Pull Request
                </button>
              )}
            </div>
          )}
        </div>

      </div>

      {/* Create Repository Modal */}
      {showCreateModal && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(var(--bg-base-rgb), 0.58)',
          backdropFilter: 'blur(10px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          padding: 'var(--space-4)',
        }}>
          <div style={{
            background: 'var(--review-shell-bg)',
            border: '1px solid var(--review-shell-border-strong)',
            borderRadius: 18,
            maxWidth: 448,
            width: '100%',
            boxShadow: 'var(--review-panel-shadow)',
            fontFamily: 'var(--font-sans)',
            overflow: 'hidden',
          }}>
            <div style={{
              padding: '20px 24px 16px',
              borderBottom: '1px solid var(--review-shell-divider)',
              background: 'var(--review-panel-header-bg)',
            }}>
              <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)' }}>Create GitHub Repository</h2>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginTop: 'var(--space-1)' }}>Create a new repository for this project</p>
            </div>

            <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', background: 'var(--review-panel-alt-bg)' }}>
              <div>
                <label style={{
                  display: 'block',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 500,
                  color: 'var(--text-secondary)',
                  marginBottom: 6,
                }}>
                  Repository Name
                </label>
                <input
                  type="text"
                  value={repoName}
                  onChange={(e) => setRepoName(sanitizeRepoName(e.target.value))}
                  placeholder="my-project"
                  disabled={creating}
                  style={{
                    width: '100%',
                    padding: 'var(--space-2) var(--space-3)',
                    background: 'var(--review-code-bg)',
                    border: '1px solid var(--review-shell-border)',
                    borderRadius: 12,
                    color: 'var(--text-primary)',
                    fontSize: 'var(--text-sm)',
                    fontFamily: 'var(--font-sans)',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{
                  display: 'block',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 500,
                  color: 'var(--text-secondary)',
                  marginBottom: 'var(--space-2)',
                }}>Visibility</label>
                <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                  <button
                    type="button"
                    onClick={() => setIsPrivate(true)}
                    disabled={creating}
                    style={{
                      flex: 1,
                      padding: 'var(--space-2) var(--space-3)',
                      borderRadius: 10,
                      fontSize: 'var(--text-sm)',
                      fontFamily: 'var(--font-sans)',
                      cursor: 'pointer',
                      transition: `border-color var(--transition-fast), background var(--transition-fast)`,
                      border: isPrivate
                        ? '1px solid var(--review-segment-active-border)'
                        : '1px solid var(--review-shell-border)',
                      background: isPrivate
                        ? 'var(--review-segment-active-bg)'
                        : 'var(--review-card-bg)',
                      color: isPrivate
                        ? 'var(--text-primary)'
                        : 'var(--text-secondary)',
                    }}
                  >
                    Private
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPrivate(false)}
                    disabled={creating}
                    style={{
                      flex: 1,
                      padding: 'var(--space-2) var(--space-3)',
                      borderRadius: 10,
                      fontSize: 'var(--text-sm)',
                      fontFamily: 'var(--font-sans)',
                      cursor: 'pointer',
                      transition: `border-color var(--transition-fast), background var(--transition-fast)`,
                      border: !isPrivate
                        ? '1px solid var(--review-segment-active-border)'
                        : '1px solid var(--review-shell-border)',
                      background: !isPrivate
                        ? 'var(--review-segment-active-bg)'
                        : 'var(--review-card-bg)',
                      color: !isPrivate
                        ? 'var(--text-primary)'
                        : 'var(--text-secondary)',
                    }}
                  >
                    Public
                  </button>
                </div>
              </div>
            </div>

            <div style={{
              padding: 'var(--space-4)',
              borderTop: '1px solid var(--review-shell-divider)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 'var(--space-3)',
              background: 'var(--review-panel-header-bg)',
            }}>
              <button
                onClick={() => setShowCreateModal(false)}
                disabled={creating}
                onMouseEnter={() => setHoveredBtn('cancelCreate')}
                onMouseLeave={() => setHoveredBtn(null)}
                style={{
                  ...ghostBtnStyle,
                  padding: 'var(--space-2) var(--space-4)',
                  color: hoveredBtn === 'cancelCreate' ? 'var(--text-primary)' : 'var(--text-tertiary)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreateRepo}
                disabled={creating || !repoName.trim()}
                onMouseEnter={() => setHoveredBtn('confirmCreate')}
                onMouseLeave={() => setHoveredBtn(null)}
                style={{
                  ...primaryBtnStyle,
                  padding: 'var(--space-2) var(--space-4)',
                  opacity: (creating || !repoName.trim()) ? 0.5 : hoveredBtn === 'confirmCreate' ? 0.85 : 1,
                  cursor: (creating || !repoName.trim()) ? 'not-allowed' : 'pointer',
                }}
              >
                {creating && <div className="animate-spin" style={{
                  borderRadius: 'var(--radius-full)',
                  height: 16,
                  width: 16,
                  borderBottom: '2px solid var(--bg-base)',
                  borderTop: '2px solid transparent',
                  borderLeft: '2px solid transparent',
                  borderRight: '2px solid transparent',
                }} />}
                {creating ? 'Creating...' : 'Create Repository'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
