/**
 * GitHub Import Modal Component
 * Modal for importing repositories from GitHub (following Emergent design)
 */

import { useState, useEffect, useCallback } from 'react';
import toast from '@/lib/toast';
import githubApi, { type GitHubInstallation, type GitHubRepository } from '@/services/githubApi';
import type { Project } from '@/types';
import useGitHubDeviceFlow from '@/hooks/useGitHubDeviceFlow';
import DeviceCodeDisplay from '@/components/DeviceCodeDisplay';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface GitHubImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImported: (project: Project) => void;
}

type RepositoryType = 'private' | 'public';

export default function GitHubImportModal({
  isOpen,
  onClose,
  onImported,
}: GitHubImportModalProps) {
  // Tab state
  const [repoType, setRepoType] = useState<RepositoryType>('private');

  // GitHub connection state
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [installation, setInstallation] = useState<GitHubInstallation | null>(null);
  const [loadingInstallation, setLoadingInstallation] = useState(true);

  // Device flow hook
  const refreshInstallations = useCallback(async () => {
    setLoadingInstallation(true);
    try {
      const all = await githubApi.getInstallations();
      setInstallations(all);
      if (all.length > 0) {
        const active = all.find(i => i.isActive) || all[0];
        setInstallation(active);
      } else {
        setInstallation(null);
      }
    } catch {
      setInstallation(null);
    } finally {
      setLoadingInstallation(false);
    }
  }, []);

  const handleDeviceFlowConnected = useCallback(async (_inst: GitHubInstallation) => {
    setAuthExpired(false);
    await refreshInstallations();
  }, [refreshInstallations]);

  const { connecting, deviceCode, connect: handleConnect, cancel: cancelDeviceFlow } =
    useGitHubDeviceFlow({ onConnected: handleDeviceFlowConnected });

  // Repository selection state (private)
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepository | null>(null);
  const [repoSearchQuery, setRepoSearchQuery] = useState('');
  const [showRepoDropdown, setShowRepoDropdown] = useState(false);

  // Branch selection state
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');

  // Public repo state
  const [publicRepoUrl, setPublicRepoUrl] = useState('');

  // Auth expired state
  const [authExpired, setAuthExpired] = useState(false);

  // Import state
  const [importing, setImporting] = useState(false);

  // Hover states for interactive elements
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [hoveredRepo, setHoveredRepo] = useState<number | null>(null);

  // Load all GitHub installations on mount
  useEffect(() => {
    if (isOpen) {
      refreshInstallations();
    }
  }, [isOpen, refreshInstallations]);

  // Load repositories when installation is available
  useEffect(() => {
    if (installation && repoType === 'private') {
      loadRepositories();
    }
  }, [installation, repoType]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSelectedRepo(null);
      setSelectedBranch('');
      setRepoSearchQuery('');
      setPublicRepoUrl('');
      setBranches([]);
      setShowRepoDropdown(false);
      setAuthExpired(false);
      cancelDeviceFlow();
    }
  }, [isOpen, cancelDeviceFlow]);

  const loadRepositories = async () => {
    if (!installation) return;

    try {
      setLoadingRepos(true);
      const repos = await githubApi.getRepositories(installation.installationId);

      // Sort by most recently updated first
      const sortedRepos = repos.sort((a, b) => {
        const dateA = new Date(a.updatedAt).getTime();
        const dateB = new Date(b.updatedAt).getTime();
        return dateB - dateA;
      });

      setRepositories(sortedRepos);
    } catch (err: any) {
      console.error('Failed to load repositories:', err);
      if (err.response?.status === 401 || err.response?.data?.code === 'AUTH_EXPIRED') {
        setAuthExpired(true);
      } else {
        toast.error('Failed to load repositories');
      }
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleSelectRepo = (repo: GitHubRepository) => {
    setSelectedRepo(repo);
    setRepoSearchQuery('');
    setShowRepoDropdown(false);
    setSelectedBranch(repo.defaultBranch);
    // For now, just use the default branch
    // In a full implementation, we'd fetch available branches here
    setBranches([repo.defaultBranch]);
  };

  const showIntegrationToasts = (
    integrations: Array<{ id: string; name: string; missingCount: number }>,
    autoLinked?: Array<{ id: string; name: string; supabaseProjectName?: string }>,
  ) => {
    // Show success toasts for auto-linked integrations
    if (autoLinked && autoLinked.length > 0) {
      for (const item of autoLinked) {
        if (item.id === 'supabase') {
          toast.success(
            `Supabase auto-linked to "${item.supabaseProjectName || 'project'}". Dev server will inject env vars.`,
            { duration: 6000 },
          );
        }
      }
    }

    if (!integrations || integrations.length === 0) return;

    for (const integration of integrations) {
      if (integration.missingCount <= 0) continue;

      if (integration.id === 'supabase') {
        // Supabase notification is handled via chat message when dev server starts
        // (placeholder injection triggers a system message in ChatPanel)
        continue;
      }
      toast(`This project uses ${integration.name}. Set up required secrets in Project Settings > Secrets.`, {
        duration: 6000,
        icon: '\u{1F527}',
      });
    }
  };

  const handleImportPrivate = async () => {
    if (!selectedRepo) return;

    try {
      setImporting(true);

      const { project, alreadyExists, integrations, autoLinkedIntegrations } = await githubApi.cloneRepository({
        owner: selectedRepo.owner,
        repo: selectedRepo.name,
        installationId: installation?.installationId,
        branch: selectedBranch || selectedRepo.defaultBranch,
      });

      if (alreadyExists) {
        toast.success(`"${project.name}" is already added. Switched to existing project.`);
      } else {
        toast.success(`Imported "${selectedRepo.name}" successfully!`);
        showIntegrationToasts(integrations, autoLinkedIntegrations);
      }
      onImported(project as unknown as Project);
      onClose();
    } catch (err: any) {
      console.error('Failed to import repository:', err);
      toast.error(err.response?.data?.error || 'Failed to import repository');
    } finally {
      setImporting(false);
    }
  };

  const handleImportPublic = async () => {
    if (!publicRepoUrl.trim()) return;

    // Parse the GitHub URL
    const urlPattern = /github\.com\/([^\/]+)\/([^\/\s]+)/;
    const match = publicRepoUrl.match(urlPattern);

    if (!match) {
      toast.error('Invalid GitHub URL. Please enter a valid repository URL.');
      return;
    }

    const [, owner, repo] = match;
    const cleanRepo = repo.replace(/\.git$/, '');

    try {
      setImporting(true);

      const { project, alreadyExists, integrations, autoLinkedIntegrations } = await githubApi.cloneRepository({
        owner,
        repo: cleanRepo,
      });

      if (alreadyExists) {
        toast.success(`"${project.name}" is already added. Switched to existing project.`);
      } else {
        toast.success(`Imported "${cleanRepo}" successfully!`);
        showIntegrationToasts(integrations, autoLinkedIntegrations);
      }
      onImported(project as unknown as Project);
      onClose();
    } catch (err: any) {
      console.error('Failed to import public repository:', err);
      toast.error(err.response?.data?.error || 'Failed to import repository');
    } finally {
      setImporting(false);
    }
  };

  const filteredRepos = repositories.filter(repo =>
    repo.name.toLowerCase().includes(repoSearchQuery.toLowerCase()) ||
    repo.fullName.toLowerCase().includes(repoSearchQuery.toLowerCase())
  );

  if (!isOpen) return null;

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
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: 'var(--space-3) var(--space-4)',
    background: 'var(--review-code-bg)',
    border: '1px solid var(--review-shell-border)',
    borderRadius: 12,
    color: 'var(--text-primary)',
    fontSize: 'var(--text-sm)',
    fontFamily: 'var(--font-sans)',
    outline: 'none',
    boxSizing: 'border-box' as const,
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: 'var(--space-2)',
    fontFamily: 'var(--font-sans)',
  };

  return (
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
        maxWidth: 640,
        width: '100%',
        boxShadow: 'var(--review-panel-shadow)',
        fontFamily: 'var(--font-sans)',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--review-shell-divider)',
          background: 'var(--review-panel-header-bg)',
        }}>
          <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>Add from GitHub</h2>
          <button
            onClick={onClose}
            style={{
              ...getReviewActionButtonStyle({ tone: 'neutral' }),
              width: 32,
              minHeight: 32,
              padding: 0,
              borderRadius: 999,
              cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
          >
            <svg style={{ width: 20, height: 20 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tab Toggle */}
        <div style={{ display: 'flex', padding: 'var(--space-4) var(--space-6) 0' }}>
          <div style={{
            display: 'inline-flex',
            background: 'var(--review-segment-bg)',
            border: '1px solid var(--review-shell-border)',
            borderRadius: 12,
            padding: 'var(--space-1)',
          }}>
            <button
              onClick={() => setRepoType('private')}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                fontSize: 'var(--text-sm)',
                fontWeight: 500,
                fontFamily: 'var(--font-sans)',
                borderRadius: 10,
                transition: `background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast)`,
                border: repoType === 'private' ? '1px solid var(--review-segment-active-border)' : '1px solid transparent',
                cursor: 'pointer',
                background: repoType === 'private' ? 'var(--review-segment-active-bg)' : 'transparent',
                color: repoType === 'private' ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              Private Repository
            </button>
            <button
              onClick={() => setRepoType('public')}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                fontSize: 'var(--text-sm)',
                fontWeight: 500,
                fontFamily: 'var(--font-sans)',
                borderRadius: 10,
                transition: `background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast)`,
                border: repoType === 'public' ? '1px solid var(--review-segment-active-border)' : '1px solid transparent',
                cursor: 'pointer',
                background: repoType === 'public' ? 'var(--review-segment-active-bg)' : 'transparent',
                color: repoType === 'public' ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              Public Repository
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={{ padding: 'var(--space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)', background: 'var(--review-panel-alt-bg)' }}>
          {repoType === 'private' ? (
            <>
              {/* GitHub Connection */}
              {loadingInstallation ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-8) 0' }}>
                  <div className="animate-spin" style={{
                    width: 24,
                    height: 24,
                    borderRadius: 'var(--radius-full)',
                    borderTop: '2px solid var(--accent-blue)',
                    borderRight: '2px solid transparent',
                    borderBottom: '2px solid var(--review-shell-border)',
                    borderLeft: '2px solid transparent',
                  }} />
                </div>
              ) : !installation ? (
                <div style={{ textAlign: 'center', padding: 'var(--space-8) 0' }}>
                  {connecting && deviceCode ? (
                    <DeviceCodeDisplay deviceCode={deviceCode} variant="dark" />
                  ) : (
                    <>
                      <svg style={{ width: 48, height: 48, margin: '0 auto', color: 'var(--text-tertiary)', marginBottom: 'var(--space-4)' }} fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                      </svg>
                      <p style={{ color: 'var(--text-tertiary)', marginBottom: 'var(--space-4)', fontSize: 'var(--text-sm)' }}>Connect GitHub to import private repositories</p>
                      <button
                        onClick={handleConnect}
                        disabled={connecting}
                        onMouseEnter={() => setHoveredBtn('connectGH')}
                        onMouseLeave={() => setHoveredBtn(null)}
                        style={{
                          ...primaryBtnStyle,
                          padding: 'var(--space-2) var(--space-4)',
                          opacity: connecting ? 0.5 : hoveredBtn === 'connectGH' ? 0.85 : 1,
                        }}
                      >
                        {connecting ? 'Connecting...' : 'Connect GitHub'}
                      </button>
                    </>
                  )}
                </div>
              ) : authExpired ? (
                /* Auth expired - show reconnect UI */
                <div style={{ textAlign: 'center', padding: 'var(--space-4) 0' }}>
                  <div style={{
                    background: 'var(--chip-warning-bg)',
                    border: '1px solid var(--chip-warning-border)',
                    borderRadius: 'var(--radius-lg)',
                    padding: 'var(--space-4)',
                    marginBottom: 'var(--space-4)',
                  }}>
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 'var(--space-2)',
                      color: 'var(--accent-orange)',
                      marginBottom: 'var(--space-2)',
                    }}>
                      <svg style={{ width: 20, height: 20 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>Reconnect GitHub</span>
                    </div>
                    <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                      Your GitHub connection has expired. Reconnect to access your repositories.
                    </p>
                  </div>
                  {connecting && deviceCode ? (
                    <DeviceCodeDisplay deviceCode={deviceCode} variant="dark" />
                  ) : (
                    <button
                      onClick={() => {
                        setAuthExpired(false);
                        setInstallation(null);
                        setRepositories([]);
                        handleConnect();
                      }}
                      disabled={connecting}
                      onMouseEnter={() => setHoveredBtn('reconnectGH')}
                      onMouseLeave={() => setHoveredBtn(null)}
                      style={{
                        ...primaryBtnStyle,
                        padding: 'var(--space-2) var(--space-4)',
                        opacity: connecting ? 0.5 : hoveredBtn === 'reconnectGH' ? 0.85 : 1,
                      }}
                    >
                      {connecting ? 'Connecting...' : 'Reconnect GitHub'}
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {/* Account selector — switch between connected installations */}
                  <div>
                    <label style={labelStyle}>
                      GitHub Account
                    </label>
                    {installations.length > 1 ? (
                      <div style={{
                        display: 'flex',
                        alignItems: 'stretch',
                        gap: 'var(--space-2)',
                        overflowX: 'auto',
                        overflowY: 'hidden',
                        paddingBottom: 'var(--space-1)',
                        scrollbarWidth: 'thin',
                        WebkitOverflowScrolling: 'touch',
                      }}>
                        {installations.map(inst => {
                          const isSelected = inst.installationId === installation.installationId;
                          return (
                            <button
                              key={inst.installationId}
                              onClick={() => {
                                if (!isSelected) {
                                  setInstallation(inst);
                                  setSelectedRepo(null);
                                  setSelectedBranch('');
                                  setBranches([]);
                                  setRepositories([]);
                                }
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 'var(--space-2)',
                                padding: 'var(--space-2) var(--space-3)',
                                background: isSelected ? 'var(--review-segment-active-bg)' : 'var(--review-card-bg)',
                                border: isSelected ? '1px solid var(--review-segment-active-border)' : '1px solid var(--review-shell-border)',
                                borderRadius: 12,
                                cursor: 'pointer',
                                opacity: isSelected ? 1 : 0.7,
                                transition: 'all 0.15s ease',
                                flex: '0 0 auto',
                                minWidth: 152,
                                maxWidth: 220,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {inst.avatarUrl && (
                                <img
                                  src={inst.avatarUrl}
                                  alt={inst.accountLogin}
                                  style={{ width: 24, height: 24, borderRadius: 'var(--radius-full)', flexShrink: 0 }}
                                />
                              )}
                              <span style={{
                                color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                                fontWeight: isSelected ? 500 : 400,
                                fontSize: 'var(--text-sm)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}>
                                {inst.accountLogin}
                              </span>
                              {isSelected && (
                                <span style={{
                                  width: 8,
                                  height: 8,
                                  background: 'var(--accent-green)',
                                  borderRadius: 'var(--radius-full)',
                                  flexShrink: 0,
                                }} />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-3)',
                        padding: 'var(--space-3) var(--space-4)',
                        background: 'var(--review-card-bg)',
                        border: '1px solid var(--review-shell-border)',
                        borderRadius: 12,
                      }}>
                        {installation.avatarUrl && (
                          <img
                            src={installation.avatarUrl}
                            alt={installation.accountLogin}
                            style={{ width: 32, height: 32, borderRadius: 'var(--radius-full)' }}
                          />
                        )}
                        <div style={{ flex: 1 }}>
                          <p style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: 'var(--text-sm)' }}>Connected as @{installation.accountLogin}</p>
                        </div>
                        <span style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 'var(--space-1)',
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
                      </div>
                    )}
                  </div>

                  {/* Select Repo */}
                  <div>
                    <label style={labelStyle}>
                      Select Repository
                    </label>
                    <div style={{ position: 'relative' }}>
                      <div
                        onClick={() => !loadingRepos && setShowRepoDropdown(!showRepoDropdown)}
                        onMouseEnter={() => setHoveredBtn('repoSelect')}
                        onMouseLeave={() => setHoveredBtn(null)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: 'var(--space-3) var(--space-4)',
                          background: 'var(--review-code-bg)',
                          border: `1px solid ${hoveredBtn === 'repoSelect' ? 'var(--review-shell-border-strong)' : 'var(--review-shell-border)'}`,
                          borderRadius: 12,
                          cursor: 'pointer',
                          transition: `border-color var(--transition-fast)`,
                        }}
                      >
                        {loadingRepos ? (
                          <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>Loading repositories...</span>
                        ) : selectedRepo ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                            <span style={{ color: 'var(--text-primary)', fontSize: 'var(--text-sm)' }}>{selectedRepo.name}</span>
                            {selectedRepo.private && (
                              <span style={{
                                padding: '2px 6px',
                                fontSize: 'var(--text-xs)',
                                background: 'var(--chip-warning-bg)',
                                color: 'var(--accent-yellow)',
                                borderRadius: 'var(--radius-sm)',
                              }}>
                                Private
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>Select a repository...</span>
                        )}
                        <svg style={{
                          width: 20,
                          height: 20,
                          color: 'var(--text-tertiary)',
                          transition: `transform var(--transition-fast)`,
                          transform: showRepoDropdown ? 'rotate(180deg)' : 'rotate(0deg)',
                        }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>

                      {showRepoDropdown && !loadingRepos && (
                        <div style={{
                          position: 'absolute',
                          top: '100%',
                          left: 0,
                          right: 0,
                          marginTop: 'var(--space-1)',
                          background: 'var(--review-panel-bg)',
                          border: '1px solid var(--review-shell-border)',
                          borderRadius: 12,
                          boxShadow: 'var(--review-panel-shadow)',
                          zIndex: 10,
                          maxHeight: 256,
                          overflow: 'hidden',
                        }}>
                          {/* Search */}
                          <div style={{ padding: 'var(--space-2)', borderBottom: '1px solid var(--review-shell-divider)' }}>
                            <input
                              type="text"
                              value={repoSearchQuery}
                              onChange={(e) => setRepoSearchQuery(e.target.value)}
                              placeholder="Search repositories..."
                              style={{
                                ...inputStyle,
                                padding: 'var(--space-2) var(--space-3)',
                              }}
                              autoFocus
                            />
                          </div>

                          {/* Repository List */}
                          <div style={{ maxHeight: 192, overflowY: 'auto' }}>
                            {filteredRepos.length === 0 ? (
                              <div style={{
                                padding: 'var(--space-3) var(--space-4)',
                                color: 'var(--text-tertiary)',
                                fontSize: 'var(--text-sm)',
                                textAlign: 'center',
                              }}>
                                {repositories.length === 0
                                  ? 'No repositories granted. Configure GitHub App access.'
                                  : 'No repositories found'}
                              </div>
                            ) : (
                              filteredRepos.map((repo) => (
                                <button
                                  key={repo.id}
                                  onClick={() => handleSelectRepo(repo)}
                                  onMouseEnter={() => setHoveredRepo(repo.id)}
                                  onMouseLeave={() => setHoveredRepo(null)}
                                  style={{
                                    width: '100%',
                                    padding: 'var(--space-3) var(--space-4)',
                                    textAlign: 'left',
                                    background: hoveredRepo === repo.id ? 'var(--review-card-hover)' : 'transparent',
                                    transition: `background var(--transition-fast)`,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    border: 'none',
                                    cursor: 'pointer',
                                    fontFamily: 'var(--font-sans)',
                                  }}
                                >
                                  <div>
                                    <p style={{ color: 'var(--text-primary)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>{repo.name}</p>
                                    {repo.description && (
                                      <p style={{
                                        color: 'var(--text-tertiary)',
                                        fontSize: 'var(--text-xs)',
                                        marginTop: 2,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        maxWidth: 280,
                                      }}>
                                        {repo.description}
                                      </p>
                                    )}
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginLeft: 'var(--space-2)', flexShrink: 0 }}>
                                    {repo.language && (
                                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{repo.language}</span>
                                    )}
                                    {repo.private && (
                                      <span style={{
                                        padding: '2px 6px',
                                        fontSize: 'var(--text-xs)',
                                        background: 'var(--chip-warning-bg)',
                                        color: 'var(--accent-yellow)',
                                        borderRadius: 'var(--radius-sm)',
                                      }}>
                                        Private
                                      </span>
                                    )}
                                  </div>
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Select Branch */}
                  <div>
                    <label style={labelStyle}>
                      Select Branch
                    </label>
                    <div style={{ position: 'relative' }}>
                      <select
                        value={selectedBranch}
                        onChange={(e) => setSelectedBranch(e.target.value)}
                        disabled={!selectedRepo}
                        style={{
                          ...inputStyle,
                          appearance: 'none',
                          cursor: selectedRepo ? 'pointer' : 'not-allowed',
                          opacity: selectedRepo ? 1 : 0.5,
                        }}
                      >
                        {!selectedRepo && (
                          <option value="">Select a repository first</option>
                        )}
                        {branches.map((branch) => (
                          <option key={branch} value={branch}>
                            {branch}
                          </option>
                        ))}
                      </select>
                      <svg style={{
                        position: 'absolute',
                        right: 16,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: 20,
                        height: 20,
                        color: 'var(--text-tertiary)',
                        pointerEvents: 'none',
                      }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                </>
              )}
            </>
          ) : (
            /* Public Repository */
            <div>
              <label style={labelStyle}>
                Repository URL
              </label>
              <input
                type="text"
                value={publicRepoUrl}
                onChange={(e) => setPublicRepoUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                style={inputStyle}
              />
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-2)' }}>
                Enter the full URL to a public GitHub repository
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: 'var(--space-4) var(--space-6)',
          borderTop: '1px solid var(--review-shell-divider)',
          display: 'flex',
          justifyContent: 'flex-end',
          background: 'var(--review-panel-header-bg)',
        }}>
          <button
            onClick={repoType === 'private' ? handleImportPrivate : handleImportPublic}
            disabled={
              importing ||
              (repoType === 'private' && !selectedRepo) ||
              (repoType === 'public' && !publicRepoUrl.trim())
            }
            onMouseEnter={() => setHoveredBtn('import')}
            onMouseLeave={() => setHoveredBtn(null)}
            style={{
              ...primaryBtnStyle,
              padding: '0 var(--space-6)',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              opacity: (
                importing ||
                (repoType === 'private' && !selectedRepo) ||
                (repoType === 'public' && !publicRepoUrl.trim())
              ) ? 0.5 : hoveredBtn === 'import' ? 0.85 : 1,
              cursor: (
                importing ||
                (repoType === 'private' && !selectedRepo) ||
                (repoType === 'public' && !publicRepoUrl.trim())
              ) ? 'not-allowed' : 'pointer',
            }}
          >
            {importing ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <div className="animate-spin" style={{
                  width: 16,
                  height: 16,
                  borderRadius: 'var(--radius-full)',
                  borderTop: '2px solid var(--accent-blue)',
                  borderRight: '2px solid transparent',
                  borderBottom: '2px solid var(--review-shell-border)',
                  borderLeft: '2px solid transparent',
                }} />
                Importing...
              </span>
            ) : (
              'Import'
            )}
          </button>
        </div>
      </div>

      {/* Click outside to close dropdown */}
      {showRepoDropdown && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 0 }}
          onClick={() => setShowRepoDropdown(false)}
        />
      )}
    </div>
  );
}
