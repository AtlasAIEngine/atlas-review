import React, { useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { useThemeStore } from '../stores/themeStore';

interface DiffViewerProps {
  filePath: string;
  beforeContent: string | null;
  afterContent: string;
  isNewFile: boolean;
  language: string;
  stats: {
    additions: number;
    deletions: number;
  };
  defaultCollapsed?: boolean;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  filePath,
  beforeContent,
  afterContent,
  isNewFile,
  language,
  stats,
  defaultCollapsed = false,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [viewMode, setViewMode] = useState<'side-by-side' | 'inline'>('side-by-side');
  const resolved = useThemeStore((s) => s.resolved);

  // Calculate a reasonable height based on content
  const lineCount = Math.max(
    (beforeContent || '').split('\n').length,
    afterContent.split('\n').length
  );
  const editorHeight = Math.min(Math.max(lineCount * 19 + 20, 150), 400);

  return (
    <div className="bg-surface-base rounded-lg border border-border overflow-hidden my-2">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 bg-surface cursor-pointer hover:bg-surface-elevated/50 transition-colors"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg
            className={`w-4 h-4 flex-shrink-0 transition-transform duration-200 text-content-secondary ${
              isCollapsed ? '' : 'rotate-90'
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
          <span className="text-accent-blue flex-shrink-0">
            {isNewFile ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            )}
          </span>
          <span className="text-sm font-medium text-content truncate">
            {isNewFile ? 'Created' : 'Modified'}: {filePath}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs flex-shrink-0 ml-2">
          {stats.additions > 0 && (
            <span className="text-accent-green font-mono">+{stats.additions}</span>
          )}
          {stats.deletions > 0 && (
            <span className="text-accent-red font-mono">-{stats.deletions}</span>
          )}
        </div>
      </div>

      {/* Diff Content */}
      {!isCollapsed && (
        <div>
          {/* View Toggle */}
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-surface/50 border-t border-border">
            <div className="flex items-center gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setViewMode('side-by-side');
                }}
                className={`text-xs px-2 py-1 rounded transition-colors ${
                  viewMode === 'side-by-side'
                    ? 'bg-accent-blue text-white'
                    : 'text-content-secondary hover:text-content hover:bg-surface-elevated'
                }`}
              >
                Side by Side
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setViewMode('inline');
                }}
                className={`text-xs px-2 py-1 rounded transition-colors ${
                  viewMode === 'inline'
                    ? 'bg-accent-blue text-white'
                    : 'text-content-secondary hover:text-content hover:bg-surface-elevated'
                }`}
              >
                Inline
              </button>
            </div>
            <span className="text-xs text-content-tertiary">
              {lineCount} lines
            </span>
          </div>

          {/* Monaco Diff Editor */}
          <div style={{ height: editorHeight }}>
            <DiffEditor
              original={beforeContent || ''}
              modified={afterContent}
              language={language}
              theme={resolved === 'light' ? 'vs' : 'vs-dark'}
              options={{
                readOnly: true,
                renderSideBySide: viewMode === 'side-by-side',
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: 12,
                lineNumbers: 'on',
                folding: false,
                wordWrap: 'off',
                scrollbar: {
                  vertical: 'auto',
                  horizontal: 'auto',
                  verticalScrollbarSize: 8,
                  horizontalScrollbarSize: 8,
                },
                renderOverviewRuler: false,
                diffWordWrap: 'off',
                ignoreTrimWhitespace: false,
                renderIndicators: true,
                originalEditable: false,
                domReadOnly: true,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default DiffViewer;
