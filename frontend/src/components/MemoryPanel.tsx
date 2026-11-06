/**
 * Memory Panel Component
 * View/edit CLAUDE.md with checkpoint creation
 */

import { useState, useEffect } from 'react';
import { memoryApi } from '@/services/api';
import type { MemoryStats } from '@/types';
import { usePopup } from './shared/PopupProvider';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface MemoryPanelProps {
  projectId: string;
}

function MemoryPanel({ projectId }: MemoryPanelProps) {
  const popup = usePopup();
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    loadMemory();
  }, [projectId]);

  const loadMemory = async () => {
    setLoading(true);
    try {
      const response = await memoryApi.get(projectId);
      setContent(response.content);
      setOriginalContent(response.content);
      setStats(response.stats);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to load memory:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    setHasChanges(e.target.value !== originalContent);
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      // Parse the content to extract structured updates
      // For now, we'll just save the entire content as one update
      await memoryApi.update(projectId, { content });
      setOriginalContent(content);
      setHasChanges(false);
      await loadMemory();
    } catch (error) {
      console.error('Failed to save memory:', error);
      await popup.alert({
        title: 'Save Failed',
        message: 'Failed to save memory.',
        danger: true,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCheckpoint = async () => {
    const name = await popup.prompt({
      title: 'Create Checkpoint',
      message: 'Checkpoint name:',
      placeholder: 'e.g. Before auth refactor',
      confirmLabel: 'Create checkpoint',
      cancelLabel: 'Cancel',
    });
    if (!name?.trim()) return;

    const notes = await popup.prompt({
      title: 'Checkpoint Notes',
      message: 'Add notes (optional):',
      placeholder: 'Optional notes for this checkpoint',
      multiline: true,
      confirmLabel: 'Continue',
      cancelLabel: 'Skip notes',
    });

    setLoading(true);
    try {
      await memoryApi.createCheckpoint(projectId, name.trim(), notes?.trim() || undefined);
      await popup.alert({
        title: 'Checkpoint Created',
        message: 'Checkpoint created successfully.',
      });
      await loadMemory();
    } catch (error) {
      console.error('Failed to create checkpoint:', error);
      await popup.alert({
        title: 'Checkpoint Failed',
        message: 'Failed to create checkpoint.',
        danger: true,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCompact = async () => {
    const confirmed = await popup.confirm({
      title: 'Compact Memory?',
      message: 'This keeps the last 5 snapshots and removes older auto-snapshots.',
      confirmLabel: 'Compact memory',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) {
      return;
    }

    setLoading(true);
    try {
      const response = await memoryApi.compact(projectId, 5);
      await popup.alert({
        title: 'Memory Compacted',
        message: `Removed ${response.removedCount} old snapshot${response.removedCount === 1 ? '' : 's'}.`,
      });
      await loadMemory();
    } catch (error) {
      console.error('Failed to compact memory:', error);
      await popup.alert({
        title: 'Compact Failed',
        message: 'Failed to compact memory.',
        danger: true,
      });
    } finally {
      setLoading(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  if (loading && !content) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--review-panel-bg)' }}>
        <div style={{ color: 'var(--text-tertiary)' }}>Loading memory...</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--review-panel-bg)' }}>
      {/* Header */}
      <div className="p-4" style={{ borderBottom: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-header-bg)' }}>
        <h2 className="text-lg font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Memory (CLAUDE.md)</h2>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setIsEditing(!isEditing)}
            style={getReviewActionButtonStyle({ tone: 'blue', active: true })}
          >
            {isEditing ? 'View Mode' : 'Edit Mode'}
          </button>
          {hasChanges && (
            <button
              onClick={handleSave}
              disabled={loading}
              style={getReviewActionButtonStyle({ tone: 'green', active: true, disabled: loading })}
            >
              Save Changes
            </button>
          )}
          <button
            onClick={handleCreateCheckpoint}
            disabled={loading}
            style={getReviewActionButtonStyle({ tone: 'purple', active: true, disabled: loading })}
          >
            Checkpoint
          </button>
          <button
            onClick={handleCompact}
            disabled={loading}
            style={getReviewActionButtonStyle({ tone: 'yellow', active: true, disabled: loading })}
          >
            Compact
          </button>
          <button
            onClick={loadMemory}
            disabled={loading}
            style={getReviewActionButtonStyle({ tone: 'neutral', disabled: loading })}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div
          className="p-3 grid grid-cols-2 gap-2"
          style={{
            background: 'var(--review-card-bg)',
            borderBottom: '1px solid var(--review-shell-divider)',
          }}
        >
          <div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Size</div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {formatBytes(stats.currentSize)}
            </div>
          </div>
          <div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Snapshots</div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{stats.totalSnapshots}</div>
          </div>
          <div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Last Updated</div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {stats.lastUpdate ? new Date(stats.lastUpdate).toLocaleString() : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Health</div>
            <div
              className={`text-sm font-semibold ${
                stats.currentSize > 100000 ? 'text-accent-orange' : 'text-accent-green'
              }`}
            >
              {stats.currentSize > 100000 ? 'Consider compacting' : 'Good'}
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {isEditing ? (
          <textarea
            value={content}
            onChange={handleContentChange}
            className="w-full h-full font-mono text-sm p-3 rounded resize-none focus:outline-none"
            style={{
              background: 'var(--review-code-bg)',
              color: 'var(--text-primary)',
              border: '1px solid var(--review-shell-border-strong)',
            }}
            placeholder="Edit CLAUDE.md content..."
            spellCheck={false}
          />
        ) : (
          <div
            className="p-4 rounded h-full overflow-auto"
            style={{
              background: 'var(--review-code-bg)',
              border: '1px solid var(--review-shell-border)',
            }}
          >
            <pre className="text-sm font-mono whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{content}</pre>
          </div>
        )}
      </div>

      {/* Help Text */}
      <div
        className="p-3 text-xs"
        style={{
          background: 'var(--review-panel-header-bg)',
          borderTop: '1px solid var(--review-shell-divider)',
          color: 'var(--text-tertiary)',
        }}
      >
        {isEditing ? (
          <p>
            Edit the CLAUDE.md content. Changes are saved to the memory system and create new
            snapshots.
          </p>
        ) : (
          <p>
            This is your project's persistent memory. Claude reads this to understand your project
            context across sessions.
          </p>
        )}
      </div>
    </div>
  );
}

export default MemoryPanel;
