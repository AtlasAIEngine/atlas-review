/**
 * GitHub Connect Component
 * Handles GitHub App installation, connection status, and project-level repository management
 * Supports multiple GitHub accounts (personal + organizations)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import toast from '@/lib/toast';
import githubApi, { type GitHubInstallation } from '@/services/githubApi';
import useGitHubDeviceFlow from '@/hooks/useGitHubDeviceFlow';
import DeviceCodeDisplay from '@/components/DeviceCodeDisplay';
import { openExternal } from '@/utils/openExternal';
import { isTauriEnvironment } from '@/utils/tauri';
import { usePopup } from './shared/PopupProvider';
import { findNewInstallations } from './githubConnectUtils';
import { dispatchGitHubConnectionChanged } from '@/constants/githubEvents';
import { useCurrentUser } from '@/contexts/CurrentUserContext';

type ProjectSyncStatus = Awaited<ReturnType<typeof githubApi.getProjectSyncStatus>>;
const ADD_ACCOUNT_READY_POLL_MS = 1000;
const ADD_ACCOUNT_READY_TIMEOUT_MS = 45_000;

interface GitHubConnectProps {
  currentProject?: { id: string; name: string } | null;
  onConnected?: (installation: GitHubInstallation) => void;
  onRepositoriesClick?: () => void;
  onProjectConnected?: () => void;
}

export default function GitHubConnect({
  currentProject,
  onConnected,
  onRepositoriesClick,
  onProjectConnected
}: GitHubConnectProps) {
  const popup = usePopup();
  const { user, signOut } = useCurrentUser();
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [userOrgs, setUserOrgs] = useState<Array<{ id: number; login: string; avatarUrl: string; description: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installingOrgId, setInstallingOrgId] = useState<number | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [addAccountDeviceCode, setAddAccountDeviceCode] = useState<string | null>(null);
  const [awaitingAddAccountConnect, setAwaitingAddAccountConnect] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<number | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addAccountBaselineRef = useRef<GitHubInstallation[]>([]);

  // Derive active installation for downstream consumers (onConnected, project actions)
  const activeInstallation = installations[0] || null;

  const applyInstallationData = useCallback(async (allInstallations: GitHubInstallation[]) => {
    setInstallations(allInstallations);

    if (allInstallations.length > 0) {
      const active = allInstallations.find(i => i.isActive) || allInstallations[0];
      onConnected?.(active);

      try {
        const orgs = await githubApi.getUserOrgs();
        setUserOrgs(orgs);
      } catch {
        // Non-critical — just won't show org suggestions
      }
      return;
    }

    setUserOrgs([]);
  }, [onConnected]);

  const loadInstallationData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const allInstallations = await githubApi.getInstallations({ summary: true });
      await applyInstallationData(allInstallations);
    } catch (err: any) {
      console.error('Failed to load GitHub installation:', err);
      setError(err.response?.data?.error || 'Failed to load GitHub connection');
    } finally {
      setLoading(false);
    }
  }, [applyInstallationData]);

  // Device flow hook
  const handleDeviceFlowConnected = useCallback(async (_inst: GitHubInstallation) => {
    await loadInstallationData();
  }, [loadInstallationData]);

  const handleDeviceFlowError = useCallback((msg: string) => {
    setError(msg);
  }, []);

  const { connecting, deviceCode, connect: handleConnect } =
    useGitHubDeviceFlow({ onConnected: handleDeviceFlowConnected, onError: handleDeviceFlowError });

  // Project-level state
  const [projectSyncStatus, setProjectSyncStatus] = useState<ProjectSyncStatus | null>(null);
  const [loadingProjectStatus, setLoadingProjectStatus] = useState(false);

  // Create repository modal state
  const [showCreateRepoModal, setShowCreateRepoModal] = useState(false);
  const [createRepoForm, setCreateRepoForm] = useState({ name: '', private: true });
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [repoNameError, setRepoNameError] = useState<string | null>(null);

  // Disconnect project modal state
  const [showDisconnectProjectDialog, setShowDisconnectProjectDialog] = useState(false);
  const [disconnectingProject, setDisconnectingProject] = useState(false);

  useEffect(() => {
    void loadInstallationData();
  }, [loadInstallationData]);

  useEffect(() => {
    if (currentProject && activeInstallation) {
      loadProjectSyncStatus();
    }
  }, [currentProject?.id, activeInstallation]);

  // Auto-fill repo name from project name
  useEffect(() => {
    if (currentProject && !createRepoForm.name) {
      const sanitized = sanitizeRepoName(currentProject.name);
      setCreateRepoForm(prev => ({ ...prev, name: sanitized }));
    }
  }, [currentProject]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!awaitingAddAccountConnect) {
      return;
    }

    let cancelled = false;
    let polling = false;
    const startedAt = Date.now();

    const probeInstallations = async () => {
      if (polling) return;
      polling = true;
      try {
        const updated = await githubApi.getInstallations({ summary: true });
        if (cancelled) return;
        const newAccounts = findNewInstallations(addAccountBaselineRef.current, updated);
        const ready = newAccounts.length > 0;
        if (ready) {
          setAwaitingAddAccountConnect(false);
          setAddingAccount(false);
          setAddAccountDeviceCode(null);
          await applyInstallationData(updated);
          const label = newAccounts.map((installation) => installation.accountLogin).join(', ') || 'GitHub account';
          const firstAccount = newAccounts[0];
          dispatchGitHubConnectionChanged({
            reason: 'account_added',
            accountLogin: firstAccount?.accountLogin,
            installationId: firstAccount?.installationId,
          });
          toast.success(`${label} connected`);
          return;
        }
        if (Date.now() - startedAt >= ADD_ACCOUNT_READY_TIMEOUT_MS) {
          setAwaitingAddAccountConnect(false);
          setAddingAccount(false);
        }
      } catch {
        if (!cancelled && Date.now() - startedAt >= ADD_ACCOUNT_READY_TIMEOUT_MS) {
          setAwaitingAddAccountConnect(false);
          setAddingAccount(false);
        }
      } finally {
        polling = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void probeInstallations();
      }
    };

    void probeInstallations();
    const intervalId = window.setInterval(() => {
      void probeInstallations();
    }, ADD_ACCOUNT_READY_POLL_MS);
    window.addEventListener('focus', probeInstallations);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', probeInstallations);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [applyInstallationData, awaitingAddAccountConnect]);

  const loadProjectSyncStatus = async () => {
    if (!currentProject) return;

    try {
      setLoadingProjectStatus(true);
      const status = await githubApi.getProjectSyncStatus(currentProject.id);
      setProjectSyncStatus(status);
    } catch (err: any) {
      console.error('Failed to load project sync status:', err);
      if (err.response?.status !== 404) {
        console.error('Sync status error:', err);
      }
    } finally {
      setLoadingProjectStatus(false);
    }
  };

  const sanitizeRepoName = (name: string): string => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]/g, '-')
      .replace(/^[.\-_]+|[.\-_]+$/g, '')
      .replace(/[-_.]{2,}/g, '-')
      .substring(0, 100);
  };

  const validateRepoName = (name: string): string | null => {
    if (!name || name.trim().length === 0) {
      return 'Repository name is required';
    }
    if (name.length > 100) {
      return 'Repository name must be 100 characters or less';
    }
    if (!/^[a-z0-9\-_.]+$/.test(name)) {
      return 'Only lowercase letters, numbers, hyphens, underscores, and periods allowed';
    }
    if (/^[.\-_]|[.\-_]$/.test(name)) {
      return 'Cannot start or end with special characters';
    }
    return null;
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setAddAccountDeviceCode(null);
  };

  const handleInstallOnOrg = async (orgId: number, orgLogin: string) => {
    const browserPopup = !isTauriEnvironment()
      ? window.open('', 'atlas-github-app-install', 'width=900,height=720')
      : null;
    try {
      setInstallingOrgId(orgId);
      const { installUrl } = await githubApi.getInstallUrl(orgId);

      if (browserPopup && !browserPopup.closed) {
        browserPopup.location.href = installUrl;
      } else {
        await openExternal(installUrl);
      }

      // Poll with the full endpoint so the backend discovers the org
      // installation from the existing user token; do not rely on GitHub's
      // post-install callback, which may point at a stale local tunnel.
      pollRef.current = setInterval(async () => {
        try {
          const updated = await githubApi.getInstallations({ reactivateAccount: orgLogin });
          const newOrgInstallation = updated.find((installation) => (
            installation.accountLogin.toLowerCase() === orgLogin.toLowerCase()
            && installation.isActive !== false
          ));
          if (newOrgInstallation) {
            stopPolling();
            if (browserPopup && !browserPopup.closed) {
              browserPopup.close();
            }
            await applyInstallationData(updated);
            setInstallingOrgId(null);
            dispatchGitHubConnectionChanged({
              reason: 'org_installed',
              accountLogin: orgLogin,
              installationId: newOrgInstallation?.installationId,
            });
            toast.success(`${orgLogin} connected`);
          }
        } catch {
          // Ignore polling errors
        }
      }, 3000);

      // Safety timeout after 2 minutes
      timeoutRef.current = setTimeout(() => {
        stopPolling();
        setInstallingOrgId(null);
      }, 2 * 60 * 1000);
    } catch (err: any) {
      console.error('Failed to start install on org:', err);
      if (browserPopup && !browserPopup.closed) {
        browserPopup.close();
      }
      setInstallingOrgId(null);
      toast.error('Failed to open GitHub install page');
    }
  };

  const handleAddAccount = async () => {
    try {
      setAddingAccount(true);
      addAccountBaselineRef.current = [...installations];
      const { url, step, message, userCode } = await githubApi.getConnectUrl('new-account');
      if (!url) {
        throw new Error(message || 'Failed to initiate GitHub account connection');
      }
      setAddAccountDeviceCode(step === 'device' && userCode ? userCode : null);

      await openExternal(url);
      setAwaitingAddAccountConnect(true);
    } catch (err: any) {
      console.error('Failed to start add account:', err);
      setAwaitingAddAccountConnect(false);
      setAddingAccount(false);
      setAddAccountDeviceCode(null);
      toast.error(err?.message || 'Failed to start GitHub account connection');
    }
  };

  const handleDisconnectInstallation = async (inst: GitHubInstallation) => {
    const confirmed = await popup.confirm({
      title: 'Disconnect GitHub Account?',
      message: `Disconnect ${inst.accountLogin}? This will disable sync for projects linked to this account.`,
      confirmLabel: 'Disconnect account',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) {
      return;
    }

    try {
      setDisconnectingId(inst.installationId);
      await githubApi.disconnectInstallation(inst.installationId);
      const updated = installations.filter(i => i.installationId !== inst.installationId);
      setInstallations(updated);

      if (updated.length > 0) {
        const active = updated[0];
        onConnected?.(active);
      }

      if (updated.length === 0) {
        setProjectSyncStatus(null);
      }

      dispatchGitHubConnectionChanged({
        reason: 'account_disconnected',
        accountLogin: inst.accountLogin,
        installationId: inst.installationId,
      });
      await loadInstallationData();
      toast.success(`${inst.accountLogin} disconnected`);
    } catch (err: any) {
      console.error('Failed to disconnect installation:', err);
      toast.error(err.response?.data?.error || 'Failed to disconnect account');
    } finally {
      setDisconnectingId(null);
    }
  };

  const handleSignOut = async () => {
    const accountLabels = installations.map(inst => `@${inst.accountLogin}`).join(', ');
    const confirmed = await popup.confirm({
      title: 'Sign out of GitHub?',
      message: installations.length > 0
        ? `Sign out and disconnect ${accountLabels}? This will disable sync for projects linked to those accounts and organizations.`
        : 'Sign out of the connected GitHub account?',
      confirmLabel: 'Sign out',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) {
      return;
    }

    try {
      setSigningOut(true);
      const disconnectResults = await Promise.allSettled(
        installations.map(inst => githubApi.disconnectInstallation(inst.installationId))
      );
      const failedDisconnects = disconnectResults.filter(result => result.status === 'rejected').length;

      await signOut();
      setInstallations([]);
      setUserOrgs([]);
      setProjectSyncStatus(null);
      dispatchGitHubConnectionChanged({ reason: 'account_disconnected' });
      if (failedDisconnects > 0) {
        toast.info('Signed out of GitHub. Some repository connections could not be removed.');
      } else {
        toast.success('Signed out of GitHub');
      }
    } catch (err: any) {
      console.error('Failed to sign out of GitHub:', err);
      toast.error(err?.response?.data?.error || err?.message || 'Failed to sign out of GitHub');
      await loadInstallationData();
    } finally {
      setSigningOut(false);
    }
  };

  const handleConnectProject = () => {
    if (!currentProject) return;
    setShowCreateRepoModal(true);
    setCreateRepoForm({
      name: sanitizeRepoName(currentProject.name),
      private: true
    });
    setRepoNameError(null);
  };

  const handleRepoNameChange = (name: string) => {
    const sanitized = sanitizeRepoName(name);
    setCreateRepoForm({ ...createRepoForm, name: sanitized });

    const error = validateRepoName(sanitized);
    setRepoNameError(error);
  };

  const handleCreateRepository = async () => {
    if (!currentProject) return;

    const error = validateRepoName(createRepoForm.name);
    if (error) {
      setRepoNameError(error);
      return;
    }

    try {
      setCreatingRepo(true);
      const response = await githubApi.createRepository(currentProject.id, {
        name: createRepoForm.name,
        private: createRepoForm.private
      });

      if (response.success) {
        toast.success(`Repository ${response.repository.fullName} created successfully!`);
        setShowCreateRepoModal(false);
        await loadProjectSyncStatus();
        dispatchGitHubConnectionChanged({
          reason: 'project_linked',
          projectId: currentProject.id,
        });
        onProjectConnected?.();
      }
    } catch (err: any) {
      console.error('Failed to create repository:', err);
      toast.error(err.response?.data?.error || 'Failed to create repository');
    } finally {
      setCreatingRepo(false);
    }
  };

  const handleDisconnectProject = () => {
    setShowDisconnectProjectDialog(true);
  };

  const handleConfirmDisconnectProject = async () => {
    if (!currentProject) return;

    try {
      setDisconnectingProject(true);
      const response = await githubApi.unlinkProject(currentProject.id);

      if (response.success) {
        toast.success('Project disconnected from GitHub');
        setShowDisconnectProjectDialog(false);
        setProjectSyncStatus(null);
        await loadProjectSyncStatus();
        onProjectConnected?.();
      }
    } catch (err: any) {
      console.error('Failed to disconnect project:', err);
      toast.error(err.response?.data?.error || 'Failed to disconnect project');
    } finally {
      setDisconnectingProject(false);
    }
  };

  const isProjectLinked = projectSyncStatus?.syncEnabled || false;

  if (loading) {
    return (
      <div className="px-5 py-4 text-sm text-content-tertiary">
        Loading GitHub accounts...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-accent-red/10 border border-accent-red/30 rounded-lg">
        <div className="flex items-start">
          <svg className="w-5 h-5 text-accent-red mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
          <div className="ml-3 flex-1">
            <p className="text-sm text-accent-red">{error}</p>
            <button
              onClick={() => setError(null)}
              className="mt-2 text-xs text-accent-red hover:text-accent-red/80 underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (installations.length === 0) {
    return (
      <div className="p-6 bg-surface border border-border rounded-lg shadow-sm">
        <div className="flex items-start">
          <svg className="w-8 h-8 text-content" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          <div className="ml-4 flex-1">
            <h3 className="text-lg font-semibold text-content">Connect GitHub</h3>
            {connecting && deviceCode ? (
              <DeviceCodeDisplay deviceCode={deviceCode} variant="light" />
            ) : (
              <>
                <p className="mt-1 text-sm text-content-tertiary">
                  Connect your GitHub account to clone repositories and enable real-time sync.
                </p>
                <button
                  onClick={handleConnect}
                  disabled={connecting}
                  className="mt-4 px-4 py-2 bg-surface-base text-content rounded-lg hover:bg-surface-hover transition-colors flex items-center disabled:opacity-50"
                >
                  <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                  </svg>
                  {connecting ? 'Connecting...' : 'Connect GitHub'}
                </button>
                {!user?.isGuest && (
                  <button
                    onClick={handleSignOut}
                    disabled={signingOut}
                    className="mt-3 px-3 py-1.5 text-sm font-medium text-accent-red bg-accent-red/10 hover:bg-accent-red/20 rounded transition-colors disabled:opacity-50"
                  >
                    {signingOut ? 'Signing out...' : 'Sign out'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="bg-surface border border-border rounded-lg shadow-sm">
        {/* Account list */}
        <div className="divide-y divide-border-muted">
          {installations.map(inst => (
            <div key={inst.installationId} className="flex items-center px-5 py-3.5">
              {inst.avatarUrl && (
                <img
                  src={inst.avatarUrl}
                  alt={inst.accountLogin}
                  className="w-9 h-9 rounded-full border border-border flex-shrink-0"
                />
              )}
              <div className="ml-3 flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-content truncate">Connected as @{inst.accountLogin}</span>
                  <span className="px-1.5 py-0.5 text-[10px] font-medium bg-surface-elevated text-content-tertiary rounded">
                    {inst.accountType}
                  </span>
                  <svg className="w-4 h-4 text-accent-green flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                </div>
              </div>
              <button
                onClick={() => handleDisconnectInstallation(inst)}
                disabled={disconnectingId === inst.installationId || signingOut}
                className="ml-2 p-1.5 text-content-secondary hover:text-accent-red hover:bg-accent-red/10 rounded transition-colors disabled:opacity-50 flex-shrink-0"
                title={`Disconnect ${inst.accountLogin}`}
              >
                {disconnectingId === inst.installationId ? (
                  <div className="w-4 h-4 animate-spin rounded-full border-2 border-border-strong border-t-content-tertiary"></div>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}
              </button>
            </div>
          ))}
        </div>

        {/* Unconnected organizations — show GitHub App configuration for each */}
        {(() => {
          const connectedLogins = new Set(installations.map(i => i.accountLogin.toLowerCase()));
          const unconnectedOrgs = userOrgs.filter(o => !connectedLogins.has(o.login.toLowerCase()));
          if (unconnectedOrgs.length === 0) return null;
          return (
            <div className="border-t border-border-muted">
              <div className="px-5 pt-3 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary">Repository Access</span>
              </div>
              {unconnectedOrgs.map(org => (
                <div key={org.id} className="flex items-center px-5 py-2.5">
                  {org.avatarUrl && (
                    <img
                      src={org.avatarUrl}
                      alt={org.login}
                      className="w-8 h-8 rounded-full border border-border flex-shrink-0 opacity-60"
                    />
                  )}
                  <div className="ml-3 flex-1 min-w-0">
                    <span className="text-sm font-medium text-content-tertiary truncate">{org.login}</span>
                  </div>
                  <button
                    onClick={() => handleInstallOnOrg(org.id, org.login)}
                    disabled={installingOrgId === org.id}
                    className="ml-2 px-2.5 py-1 text-xs font-medium text-accent-blue bg-accent-blue/10 hover:bg-accent-blue/20 rounded transition-colors disabled:opacity-50 flex-shrink-0"
                  >
                    {installingOrgId === org.id ? (
                      <span className="flex items-center">
                        <span className="w-3 h-3 mr-1 animate-spin rounded-full border-2 border-accent-blue/40 border-t-accent-blue inline-block"></span>
                        Opening...
                      </span>
                    ) : (
                      'Configure GitHub App'
                    )}
                  </button>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Add GitHub Account button — always visible as fallback */}
        <div className="px-5 py-3 border-t border-border-muted">
          <button
            onClick={handleAddAccount}
            disabled={addingAccount || installingOrgId !== null || signingOut}
            className="flex items-center text-sm font-medium text-accent-blue hover:text-accent-blue/80 transition-colors disabled:opacity-50"
          >
            {addingAccount ? (
              <>
                <span className="w-4 h-4 mr-2 animate-spin rounded-full border-2 border-accent-blue/40 border-t-accent-blue inline-block"></span>
                Waiting for GitHub approval...
              </>
            ) : (
              <>
                <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                Add GitHub Account
              </>
            )}
          </button>
          {addingAccount && addAccountDeviceCode ? (
            <div className="mt-3">
              <DeviceCodeDisplay deviceCode={addAccountDeviceCode} variant="light" />
            </div>
          ) : null}
        </div>

        {!user?.isGuest && (
          <div className="px-5 py-3 border-t border-border-muted flex justify-start">
            <button
              onClick={handleSignOut}
              disabled={signingOut || disconnectingId !== null}
              className="px-3 py-1.5 text-sm font-medium text-accent-red bg-accent-red/10 hover:bg-accent-red/20 rounded transition-colors disabled:opacity-50 flex-shrink-0"
            >
              {signingOut ? 'Signing out...' : 'Sign out'}
            </button>
          </div>
        )}

        {/* Project-level actions */}
        {(onRepositoriesClick || currentProject) && (
          <div className="px-5 py-3 border-t border-border bg-surface-base rounded-b-lg">
            <div className="flex items-center flex-wrap gap-3">
              {onRepositoriesClick && (
                <button
                  onClick={onRepositoriesClick}
                  className="text-sm font-medium text-accent-blue hover:text-accent-blue/80 transition-colors"
                >
                  Browse Repositories
                </button>
              )}

              {currentProject && !isProjectLinked && !loadingProjectStatus && (
                <>
                  {onRepositoriesClick && <span className="text-content-tertiary">|</span>}
                  <button
                    onClick={handleConnectProject}
                    className="text-sm font-medium text-accent-green hover:text-accent-green/80 transition-colors"
                  >
                    Connect Project
                  </button>
                </>
              )}

              {currentProject && isProjectLinked && (
                <>
                  {onRepositoriesClick && <span className="text-content-tertiary">|</span>}
                  <span className="px-2 py-0.5 text-xs font-medium bg-accent-blue/20 text-accent-blue rounded-full">
                    Project Linked
                  </span>
                  <span className="text-content-tertiary">|</span>
                  <button
                    onClick={handleDisconnectProject}
                    className="text-sm font-medium text-accent-orange hover:text-accent-orange/80 transition-colors"
                  >
                    Disconnect Project
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Create Repository Modal */}
      {showCreateRepoModal && (
        <div className="fixed inset-0 bg-surface-overlay/50 flex items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-lg max-w-md w-full shadow-xl">
            <div className="p-6 border-b border-border">
              <h2 className="text-xl font-semibold text-content">Create GitHub Repository</h2>
              <p className="text-sm text-content-tertiary mt-1">
                Create a new repository and connect your project
              </p>
            </div>

            <div className="p-6 space-y-5">
              {/* Repository Name */}
              <div>
                <label htmlFor="repo-name" className="block text-sm font-medium text-content mb-2">
                  Repository Name <span className="text-accent-red">*</span>
                </label>
                <input
                  id="repo-name"
                  type="text"
                  value={createRepoForm.name}
                  onChange={(e) => handleRepoNameChange(e.target.value)}
                  placeholder="my-project"
                  className={`w-full px-3 py-2 bg-surface border rounded-lg focus:ring-2 text-content ${
                    repoNameError
                      ? 'border-accent-red/50 focus:ring-accent-red focus:border-accent-red'
                      : 'border-border-strong focus:ring-accent-blue focus:border-accent-blue'
                  }`}
                  disabled={creatingRepo}
                />
                {repoNameError ? (
                  <p className="text-xs text-accent-red mt-1">{repoNameError}</p>
                ) : (
                  <p className="text-xs text-content-tertiary mt-1">
                    Lowercase letters, numbers, hyphens, underscores, and periods
                  </p>
                )}
              </div>

              {/* Visibility */}
              <div>
                <label className="block text-sm font-medium text-content mb-3">
                  Visibility
                </label>
                <div className="space-y-2">
                  {/* Private Option */}
                  <button
                    type="button"
                    onClick={() => setCreateRepoForm({ ...createRepoForm, private: true })}
                    disabled={creatingRepo}
                    className={`w-full flex items-start p-4 border-2 rounded-lg transition-all ${
                      createRepoForm.private
                        ? 'border-accent-blue bg-accent-blue/10'
                        : 'border-border bg-surface hover:border-border-strong'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <div className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 ${
                      createRepoForm.private
                        ? 'border-accent-blue bg-accent-blue'
                        : 'border-border-strong bg-surface'
                    }`}>
                      {createRepoForm.private && (
                        <svg className="w-3 h-3 text-content" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <div className="ml-3 text-left">
                      <div className="font-medium text-content">Private</div>
                      <div className="text-sm text-content-tertiary mt-0.5">
                        Only you and collaborators can see this repository
                      </div>
                    </div>
                  </button>

                  {/* Public Option */}
                  <button
                    type="button"
                    onClick={() => setCreateRepoForm({ ...createRepoForm, private: false })}
                    disabled={creatingRepo}
                    className={`w-full flex items-start p-4 border-2 rounded-lg transition-all ${
                      !createRepoForm.private
                        ? 'border-accent-blue bg-accent-blue/10'
                        : 'border-border bg-surface hover:border-border-strong'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <div className={`flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 ${
                      !createRepoForm.private
                        ? 'border-accent-blue bg-accent-blue'
                        : 'border-border-strong bg-surface'
                    }`}>
                      {!createRepoForm.private && (
                        <svg className="w-3 h-3 text-content" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <div className="ml-3 text-left">
                      <div className="font-medium text-content">Public</div>
                      <div className="text-sm text-content-tertiary mt-0.5">
                        Anyone can see this repository
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <div className="p-6 bg-surface-base border-t border-border flex items-center justify-end space-x-3">
              <button
                onClick={() => {
                  setShowCreateRepoModal(false);
                  setCreateRepoForm({
                    name: '',
                    private: true,
                  });
                }}
                disabled={creatingRepo}
                className="px-4 py-2 text-content hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateRepository}
                disabled={creatingRepo || !createRepoForm.name.trim() || !!repoNameError}
                className="px-4 py-2 bg-accent-green text-content rounded-lg hover:bg-accent-green/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                {creatingRepo ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-content"></div>
                    <span>Creating...</span>
                  </>
                ) : (
                  <span>Create Repository</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Disconnect Project Dialog */}
      {showDisconnectProjectDialog && (
        <div className="fixed inset-0 bg-surface-overlay/50 flex items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-lg max-w-md w-full shadow-xl">
            <div className="p-6 border-b border-border">
              <h2 className="text-xl font-semibold text-content">Disconnect Project from GitHub</h2>
            </div>

            <div className="p-6">
              <p className="text-content">
                This will remove the GitHub connection from this project. The repository will remain on GitHub, but sync will be disabled.
              </p>
              <p className="text-content mt-3">
                Are you sure you want to disconnect?
              </p>
            </div>

            <div className="p-6 bg-surface-base border-t border-border flex items-center justify-end space-x-3">
              <button
                onClick={() => setShowDisconnectProjectDialog(false)}
                disabled={disconnectingProject}
                className="px-4 py-2 text-content hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDisconnectProject}
                disabled={disconnectingProject}
                className="px-4 py-2 bg-accent-orange text-content rounded-lg hover:bg-accent-orange/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                {disconnectingProject ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-content"></div>
                    <span>Disconnecting...</span>
                  </>
                ) : (
                  <span>Disconnect Project</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
