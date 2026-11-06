/**
 * AddProjectStep Component
 * Step 3: Add first project (Open Local Folder / From GitHub)
 */

import { useState, useCallback } from 'react';
import { projectApi } from '@/services/api';
import GitHubImportModal from '@/components/GitHubImportModal';
import type { Project } from '@/types';
import {
  getSetupButtonStyle,
  getSetupIconBadgeStyle,
  getSetupNoticeStyle,
  getSetupOptionCardStyle,
  getSetupTextButtonStyle,
  setupInputStyle,
  setupInsetPanelStyle,
} from './setupChrome';
import { SetupButtonIcon } from './setupButtonIcons';
import { isTauriEnvironment } from '@/utils/tauri';

const isTauri = isTauriEnvironment();

interface AddProjectStepProps {
  onComplete: (projectId?: string) => void;
  onBack: () => void;
  onSkip: () => void;
}

type Mode = 'choose' | 'local';

export function AddProjectStep({ onComplete, onBack, onSkip }: AddProjectStepProps) {
  const [mode, setMode] = useState<Mode>('choose');
  const [localPath, setLocalPath] = useState('');
  const [localName, setLocalName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // GitHub import modal
  const [showGitHubModal, setShowGitHubModal] = useState(false);

  const openLocalByPath = useCallback(async (path: string, name?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await projectApi.openLocal(path.trim(), name?.trim() || undefined);
      if (result.success) {
        onComplete(result.project.id);
      } else {
        setError('Failed to open folder');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to open folder');
    } finally {
      setLoading(false);
    }
  }, [onComplete]);

  const handleOpenLocal = () => openLocalByPath(localPath, localName);

  const handleNativeFolderPick = useCallback(async () => {
    if (isTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Select project folder',
        });
        if (typeof selected === 'string') {
          await openLocalByPath(selected);
        }
        return;
      } catch (err) {
        console.error('Native dialog failed:', err);
      }
    } else {
      try {
        const result = await projectApi.pickLocalFolder();
        if (result.cancelled || !result.localPath) {
          return;
        }
        await openLocalByPath(result.localPath);
        return;
      } catch (err) {
        console.error('Browser folder picker failed:', err);
      }
    }

    // Picker failed — fall back to manual text input
    setMode('local');
  }, [openLocalByPath]);

  const handleGitHubImported = useCallback((project: Project) => {
    onComplete(project.id);
  }, [onComplete]);

  // Choose mode
  if (mode === 'choose') {
    return (
      <div className="text-center">
        <div className="mx-auto mb-6" style={getSetupIconBadgeStyle('blue')}>
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Add Your First Project</h2>
        <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>
          Point AtlasEngine at a codebase to start AI review.
        </p>

        <div className="space-y-3 mb-6 max-w-2xl mx-auto">
          {/* Open Local Folder */}
          <button
            onClick={handleNativeFolderPick}
            disabled={loading}
            className="group disabled:opacity-50"
            style={getSetupOptionCardStyle({ tone: 'blue', interactive: true })}
          >
            <div className="flex items-center gap-3">
              <div style={getSetupIconBadgeStyle('blue')}>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="font-medium" style={{ color: 'var(--text-primary)' }}>Open Local Folder</p>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>Point to an existing project on your machine</p>
              </div>
              <svg className="w-5 h-5" style={{ color: 'var(--text-tertiary)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </button>

          {/* From GitHub */}
          <button
            onClick={() => setShowGitHubModal(true)}
            className="group"
            style={getSetupOptionCardStyle({ tone: 'purple', interactive: true })}
          >
            <div className="flex items-center gap-3">
              <div style={getSetupIconBadgeStyle('purple')}>
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="font-medium" style={{ color: 'var(--text-primary)' }}>From GitHub</p>
                <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>Clone a repository from GitHub</p>
              </div>
              <svg className="w-5 h-5" style={{ color: 'var(--text-tertiary)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </button>
        </div>

        {error && (
          <div className="mb-4 max-w-md mx-auto" style={getSetupNoticeStyle('red')}>
            {error}
          </div>
        )}

        {loading && (
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>Opening folder...</p>
        )}

        <div className="flex justify-center gap-4">
          <button
            onClick={onBack}
            style={getSetupButtonStyle({ tone: 'neutral' })}
          >
            Back
          </button>
          <button
            onClick={() => onSkip()}
            style={getSetupTextButtonStyle()}
          >
            Skip — I'll add a project later
          </button>
        </div>

        {/* GitHub Import Modal — same as used everywhere else in the app */}
        <GitHubImportModal
          isOpen={showGitHubModal}
          onClose={() => setShowGitHubModal(false)}
          onImported={handleGitHubImported}
        />
      </div>
    );
  }

  // Open Local Folder form (browser fallback)
  return (
    <div className="text-center">
      <div className="mx-auto mb-6" style={getSetupIconBadgeStyle('blue')}>
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      </div>
      <h2 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Open Local Folder</h2>
      <p className="mb-6" style={{ color: 'var(--text-secondary)' }}>Enter the path to your project directory.</p>

      <div className="mb-6 text-left max-w-xl mx-auto" style={setupInsetPanelStyle}>
        <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>Folder Path</label>
        <input
          type="text"
          value={localPath}
          onChange={(e) => { setLocalPath(e.target.value); setError(null); }}
          placeholder="/Users/you/projects/my-app"
          className="mb-4 font-mono"
          style={setupInputStyle}
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && handleOpenLocal()}
        />

        <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
          Project Name <span style={{ color: 'var(--text-tertiary)' }}>(optional)</span>
        </label>
        <input
          type="text"
          value={localName}
          onChange={(e) => setLocalName(e.target.value)}
          placeholder="Auto-detected from folder name"
          className="mb-4"
          style={setupInputStyle}
        />

        {error && (
          <div className="mb-4" style={getSetupNoticeStyle('red')}>
            {error}
          </div>
        )}

        <button
          onClick={handleOpenLocal}
          disabled={!localPath.trim() || loading}
          style={getSetupButtonStyle({ tone: 'blue', active: true, disabled: !localPath.trim() || loading, fullWidth: true })}
        >
          <SetupButtonIcon name="folder" size={16} />
          {loading ? 'Opening...' : 'Open Folder'}
        </button>
      </div>

      <p className="text-xs mb-4 max-w-md mx-auto" style={{ color: 'var(--text-tertiary)' }}>
        Atlas will inspect the repository without writing `.atlas` files. Only an explicitly saved review policy is stored in the repo.
      </p>

      <button
        onClick={() => { setMode('choose'); setError(null); }}
        style={getSetupButtonStyle({ tone: 'neutral' })}
      >
        Back
      </button>
    </div>
  );
}

export default AddProjectStep;
