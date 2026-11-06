/**
 * GitHubButton Component
 * Top bar button that shows GitHub connection status and opens the popover.
 */

import { useState } from 'react';
import useGitStatus from '@/hooks/useGitStatus';
import useSyncStatus from '@/hooks/useSyncStatus';
import GitHubPopover from './GitHubPopover';

interface GitHubButtonProps {
  projectId: string;
  projectName: string;
}

export default function GitHubButton({
  projectId,
  projectName,
}: GitHubButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const { status: gitStatus, loading: gitLoading } = useGitStatus(projectId, {
    pollInterval: 30000, // Poll less frequently when popover is closed
    enablePolling: true,
  });
  const { status: syncStatus } = useSyncStatus(projectId);

  const isConnected = gitStatus?.isGitHub && gitStatus?.isRepo;
  const isDirty = gitStatus?.dirty;
  const hasChanges = (gitStatus?.ahead || 0) > 0;

  const statusDotBase: React.CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: 'var(--radius-full)',
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: '6px var(--space-3)',
          borderRadius: 'var(--radius-lg)',
          fontSize: 'var(--text-sm)',
          transition: `background var(--transition-fast), color var(--transition-fast)`,
          background: isOpen
            ? 'var(--bg-overlay)'
            : isHovered
              ? 'var(--bg-overlay)'
              : 'var(--bg-elevated)',
          color: isOpen || isHovered
            ? 'var(--text-primary)'
            : 'var(--text-secondary)',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {/* GitHub icon */}
        <svg style={{ width: 16, height: 16 }} fill="currentColor" viewBox="0 0 24 24">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
        </svg>

        {/* Status indicator */}
        {gitLoading ? (
          <div className="animate-pulse" style={{ ...statusDotBase, background: 'var(--text-tertiary)' }} />
        ) : isConnected ? (
          syncStatus?.isSyncing ? (
            <span className="animate-pulse" style={{ ...statusDotBase, background: 'var(--accent-blue)' }} />
          ) : syncStatus?.status === 'error' ? (
            <span style={{ ...statusDotBase, background: 'var(--accent-red)' }} />
          ) : isDirty ? (
            <span style={{ ...statusDotBase, background: 'var(--accent-yellow)' }} />
          ) : hasChanges ? (
            <span style={{ ...statusDotBase, background: 'var(--accent-blue)' }} />
          ) : (
            <span style={{ ...statusDotBase, background: 'var(--accent-green)' }} />
          )
        ) : (
          <span style={{ ...statusDotBase, background: 'var(--text-tertiary)' }} />
        )}

        {/* Chevron */}
        <svg
          style={{
            width: 12,
            height: 12,
            color: 'var(--text-tertiary)',
            transition: `transform var(--transition-fast)`,
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <GitHubPopover
        projectId={projectId}
        projectName={projectName}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </div>
  );
}
