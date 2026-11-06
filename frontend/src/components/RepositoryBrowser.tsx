/**
 * Repository Browser Component
 * Browse and clone GitHub repositories
 */

import { useState, useEffect } from 'react';
import toast from '@/lib/toast';
import githubApi, { type GitHubRepository, type GitHubInstallation } from '@/services/githubApi';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface RepositoryBrowserProps {
  installation: GitHubInstallation;
  installations?: GitHubInstallation[];
  onCloned?: (project: any) => void;
  onClose?: () => void;
}

export default function RepositoryBrowser({ installation: initialInstallation, installations = [], onCloned, onClose }: RepositoryBrowserProps) {
  const [activeInstallation, setActiveInstallation] = useState<GitHubInstallation>(initialInstallation);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepository | null>(null);
  const [cloning, setCloning] = useState(false);
  const [cloneProgress, setCloneProgress] = useState('');

  useEffect(() => {
    loadRepositories();
  }, [activeInstallation]);

  const loadRepositories = async () => {
    try {
      setLoading(true);
      setError(null);
      const repos = await githubApi.getRepositories(activeInstallation.installationId);

      // Sort by most recently updated first
      const sortedRepos = repos.sort((a, b) => {
        const dateA = new Date(a.updatedAt).getTime();
        const dateB = new Date(b.updatedAt).getTime();
        return dateB - dateA; // Descending order (newest first)
      });

      setRepositories(sortedRepos);
    } catch (err: any) {
      console.error('Failed to load repositories:', err);
      setError(err.response?.data?.error || 'Failed to load repositories');
    } finally {
      setLoading(false);
    }
  };

  const handleClone = async (repo: GitHubRepository) => {
    setSelectedRepo(repo);
  };

  const handleConfirmClone = async () => {
    if (!selectedRepo) return;

    try {
      setCloning(true);
      setCloneProgress('Cloning repository...');

      const result = await githubApi.cloneRepository({
        owner: selectedRepo.owner,
        repo: selectedRepo.name,
        installationId: activeInstallation.installationId,
      });

      setCloneProgress(result.alreadyExists ? 'Project already added. Switching to existing project...' : 'Clone complete!');
      toast.success(
        result.alreadyExists
          ? `"${result.project.name}" is already added. Switched to existing project.`
          : `Imported "${selectedRepo.name}" successfully!`
      );
      onCloned?.(result.project as any);

      // Close dialog after success
      setTimeout(() => {
        setSelectedRepo(null);
        setCloning(false);
        setCloneProgress('');
      }, 1000);
    } catch (err: any) {
      console.error('Failed to clone repository:', err);
      setError(err.response?.data?.error || 'Failed to clone repository');
      setCloning(false);
      setCloneProgress('');
    }
  };

  const filteredRepos = repositories.filter(repo =>
    repo.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    repo.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (repo.description && repo.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-8">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2" style={{ borderColor: 'var(--accent-blue)', borderTopColor: 'transparent' }}></div>
        <p className="mt-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading repositories...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-accent-red/10 border border-accent-red rounded-lg">
        <p className="text-sm text-accent-red">{error}</p>
        <button
          onClick={() => setError(null)}
          className="mt-2 text-xs text-accent-red hover:text-accent-red/80 underline"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--review-shell-bg)' }}>
      {/* Header */}
      <div className="flex items-center justify-between p-4" style={{ borderBottom: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-header-bg)' }}>
        <div className="flex-1">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Clone Repository</h2>
          {installations.length > 1 ? (
            <div className="flex items-center gap-1.5 mt-1.5">
              {installations.map(inst => (
                <button
                  key={inst.installationId}
                  onClick={() => {
                    if (inst.installationId !== activeInstallation.installationId) {
                      setActiveInstallation(inst);
                      setSelectedRepo(null);
                      setSearchQuery('');
                    }
                  }}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
                    inst.installationId === activeInstallation.installationId
                      ? ''
                      : ''
                  }`}
                  style={inst.installationId === activeInstallation.installationId
                    ? {
                      background: 'var(--review-segment-active-bg)',
                      color: 'var(--accent-blue)',
                      border: '1px solid var(--review-segment-active-border)',
                    }
                    : {
                      background: 'var(--review-chip-neutral-bg)',
                      color: 'var(--text-tertiary)',
                      border: '1px solid transparent',
                    }}
                >
                  {inst.avatarUrl && (
                    <img src={inst.avatarUrl} alt={inst.accountLogin} className="w-4 h-4 rounded-full" />
                  )}
                  {inst.accountLogin}
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {repositories.length} {repositories.length === 1 ? 'repository' : 'repositories'} available
            </p>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-2 rounded-lg"
            style={{ color: 'var(--text-secondary)' }}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Search */}
      <div className="p-4" style={{ borderBottom: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-bg)' }}>
        <input
          type="text"
          placeholder="Search repositories..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-4 py-2 rounded-lg focus:outline-none placeholder-content-tertiary"
          style={{
            background: 'var(--review-code-bg)',
            border: '1px solid var(--review-shell-border-strong)',
            color: 'var(--text-primary)',
          }}
        />
      </div>

      {/* Repository List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ background: 'var(--review-panel-bg)' }}>
        {filteredRepos.length === 0 ? (
          <div className="text-center py-12 rounded-lg" style={{ background: 'var(--review-card-bg)', border: '1px solid var(--review-shell-border)' }}>
            <svg className="mx-auto h-12 w-12" style={{ color: 'var(--text-secondary)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <p className="mt-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {searchQuery ? 'No repositories found' : 'No repositories available'}
            </p>
          </div>
        ) : (
          filteredRepos.map(repo => (
            <div
              key={repo.id}
              className="p-4 rounded-lg transition-all cursor-pointer"
              style={{
                background: 'var(--review-card-bg)',
                border: '1px solid var(--review-shell-border)',
                boxShadow: 'var(--review-panel-shadow)',
              }}
              onClick={() => handleClone(repo)}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{repo.name}</h3>
                    {repo.private && (
                      <span className="px-2 py-0.5 text-xs font-medium bg-accent-yellow/10 text-accent-yellow rounded-md">
                        Private
                      </span>
                    )}
                    {repo.language && (
                      <span className="px-2 py-0.5 text-xs font-medium bg-accent-blue/10 text-accent-blue rounded-md">
                        {repo.language}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>{repo.fullName}</p>
                  {repo.description && (
                    <p className="mt-2 text-sm line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{repo.description}</p>
                  )}
                </div>
                <svg className="ml-3 w-5 h-5 flex-shrink-0" style={{ color: 'var(--text-secondary)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Clone Dialog */}
      {selectedRepo && (
        <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={{ background: 'rgba(var(--bg-base-rgb), 0.58)', backdropFilter: 'blur(12px)' }}>
          <div className="max-w-md w-full" style={{ background: 'var(--review-panel-bg)', border: '1px solid var(--review-shell-border)', borderRadius: 20, boxShadow: 'var(--review-panel-shadow)' }}>
            <div className="p-6">
              <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Clone Repository</h3>
              <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                Are you sure you want to clone <span className="font-medium">{selectedRepo.fullName}</span>?
              </p>
              <div className="mt-4 p-3 rounded-lg" style={{ background: 'var(--review-card-bg)', border: '1px solid var(--review-shell-border)' }}>
                <div className="flex items-center text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clipRule="evenodd" />
                  </svg>
                  A new project will be created with this repository's content
                </div>
              </div>

              {cloneProgress && (
                <div className="mt-4 p-3 rounded-lg" style={{ background: 'var(--chip-info-bg)', border: '1px solid var(--chip-info-border)' }}>
                  <div className="flex items-center">
                    {cloning && (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 mr-2" style={{ borderColor: 'var(--accent-blue)', borderTopColor: 'transparent' }}></div>
                    )}
                    <span className="text-sm" style={{ color: 'var(--accent-blue)' }}>{cloneProgress}</span>
                  </div>
                </div>
              )}

              <div className="mt-6 flex justify-end space-x-3">
                <button
                  onClick={() => {
                    setSelectedRepo(null);
                    setCloneProgress('');
                  }}
                  disabled={cloning}
                  style={getReviewActionButtonStyle({ tone: 'neutral', disabled: cloning })}
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmClone}
                  disabled={cloning}
                  style={getReviewActionButtonStyle({ tone: 'blue', active: true, disabled: cloning })}
                >
                  {cloning ? 'Cloning...' : 'Clone Repository'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
