/**
 * ActionStrip Component
 * Collapsed summary view of tool events within a chat turn
 * Displays counts by tool type with expand/collapse functionality
 */

import React, { useState } from 'react';
import type { ToolSummary, ChatMessage } from '@/types/chat';
import { getTotalToolCount } from '@/utils/chatGrouping';
import { DiffViewer } from './DiffViewer';

/**
 * Represents a group of consecutive events with the same tool name
 */
interface ConsecutiveEventGroup {
  toolName: string;
  events: ChatMessage[];
  count: number;
}

interface ActionStripProps {
  summary: ToolSummary;
  expanded: boolean;
  onToggle: () => void;
  toolEvents: ChatMessage[];
}

// Icons for different tool types (using Lucide-style inline SVGs)
const SearchIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

const FileIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14,2 14,8 20,8" />
  </svg>
);

const PencilIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </svg>
);

const TerminalIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="4,17 10,11 4,5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const ListIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

const ToolIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

// Status indicator icons
const CheckIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="20,6 9,17 4,12" />
  </svg>
);

const AlertIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const XCircleIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="m15 9-6 6" />
    <path d="m9 9 6 6" />
  </svg>
);

const ChevronIcon: React.FC<{ className?: string; expanded: boolean }> = ({
  className,
  expanded,
}) => (
  <svg
    className={`${className} transition-transform duration-200 ${
      expanded ? 'rotate-90' : ''
    }`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="9,18 15,12 9,6" />
  </svg>
);

const ClipboardIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const ClipboardCheckIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    <polyline points="17 14 12 19 10 17" />
  </svg>
);

/**
 * Badge component for displaying tool counts
 */
const ToolBadge: React.FC<{
  icon: React.ReactNode;
  label: string;
  count: number;
}> = ({ icon, label, count }) => {
  if (count === 0) return null;

  return (
    <span className="inline-flex items-center gap-1 text-content-secondary text-xs">
      {icon}
      <span className="text-content">{count}</span>
      <span className="text-content-tertiary">{label}</span>
    </span>
  );
};

/**
 * Status indicator based on summary status
 */
const StatusIndicator: React.FC<{ status: ToolSummary['status'] }> = ({
  status,
}) => {
  switch (status) {
    case 'success':
      return <CheckIcon className="w-3.5 h-3.5 text-accent-green" />;
    case 'warning':
      return <AlertIcon className="w-3.5 h-3.5 text-accent-yellow" />;
    case 'error':
      return <XCircleIcon className="w-3.5 h-3.5 text-accent-red" />;
  }
};

/**
 * Format time from Date object
 */
const formatTime = (date: Date) => {
  return new Date(date).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
};

/**
 * Extract basename from a file path
 * Returns just the filename or last path segment
 */
const getBasename = (filePath: string): string => {
  // Handle both Unix and Windows paths
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
};

/**
 * Get a shortened path showing just src/... portion
 * Removes project-specific prefixes like /Users/.../projects/...
 */
const shortenPath = (filePath: string): string => {
  const path = String(filePath);

  // Find 'src/' in the path and show from there
  const srcIndex = path.indexOf('/src/');
  if (srcIndex !== -1) {
    return path.slice(srcIndex + 1); // Returns "src/..."
  }

  // If no src/, try to find a reasonable starting point
  // Look for common project markers
  const markers = ['/components/', '/utils/', '/hooks/', '/types/', '/services/'];
  for (const marker of markers) {
    const markerIndex = path.lastIndexOf(marker);
    if (markerIndex !== -1) {
      // Go back one level to include parent folder
      const beforeMarker = path.slice(0, markerIndex);
      const lastSlash = beforeMarker.lastIndexOf('/');
      return path.slice(lastSlash + 1);
    }
  }

  // Fallback: just return basename
  return getBasename(path);
};

/**
 * Get truncated display of tool input
 */
const getTruncatedInput = (toolInput: unknown): string => {
  if (!toolInput) return '';

  try {
    const input = toolInput as Record<string, unknown>;

    // For common tools, show the most relevant field
    if (input.pattern) return String(input.pattern);
    if (input.file_path) return shortenPath(String(input.file_path));
    if (input.path) return shortenPath(String(input.path));
    if (input.command) {
      const cmd = String(input.command);
      return cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd;
    }

    // Fallback: stringify and truncate
    const str = JSON.stringify(toolInput);
    return str.length > 50 ? str.slice(0, 50) + '...' : str;
  } catch {
    return '';
  }
};

/**
 * Group consecutive events with the same tool name
 * Returns array of groups preserving order
 */
const groupConsecutiveEvents = (events: ChatMessage[]): ConsecutiveEventGroup[] => {
  const groups: ConsecutiveEventGroup[] = [];

  for (const event of events) {
    const toolName = event.toolName || 'unknown';
    const lastGroup = groups[groups.length - 1];

    if (lastGroup && lastGroup.toolName === toolName) {
      // Add to existing group
      lastGroup.events.push(event);
      lastGroup.count++;
    } else {
      // Start new group
      groups.push({
        toolName,
        events: [event],
        count: 1,
      });
    }
  }

  return groups;
};

/**
 * Get copyable content from a bash event
 * Returns command + output if available
 */
const getBashCopyContent = (event: ChatMessage): string => {
  try {
    const input = event.toolInput as Record<string, unknown>;
    const command = input?.command ? String(input.command) : '';
    const output = event.content || '';

    if (output) {
      return `$ ${command}\n${output}`;
    }
    return `$ ${command}`;
  } catch {
    return '';
  }
};

/**
 * Render a single tool event item
 */
const ToolEventItem: React.FC<{ event: ChatMessage }> = ({ event }) => {
  const [copied, setCopied] = useState(false);
  const isBash = event.toolName?.toLowerCase() === 'bash';

  // Show DiffViewer for Write/Edit tools with diff data
  if (event.fileDiff && ['Write', 'Edit'].includes(event.toolName || '')) {
    return (
      <DiffViewer
        filePath={event.fileDiff.filePath}
        beforeContent={event.fileDiff.beforeContent}
        afterContent={event.fileDiff.afterContent}
        isNewFile={event.fileDiff.isNewFile}
        language={event.fileDiff.language}
        stats={event.fileDiff.stats}
        defaultCollapsed={true}
      />
    );
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const content = getBashCopyContent(event);
    if (content) {
      try {
        await navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy to clipboard:', err);
      }
    }
  };

  return (
    <div className="group flex items-start gap-2 px-2 py-1.5 bg-zinc-800/30 rounded text-xs">
      <span className="text-accent-blue font-mono flex-shrink-0">
        {event.toolName}
      </span>
      <span className="text-content-tertiary truncate flex-1">
        {getTruncatedInput(event.toolInput)}
      </span>
      {isBash && (
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-zinc-700 rounded flex-shrink-0"
          title={copied ? 'Copied!' : 'Copy command and output'}
        >
          {copied ? (
            <ClipboardCheckIcon className="w-3.5 h-3.5 text-accent-green" />
          ) : (
            <ClipboardIcon className="w-3.5 h-3.5 text-content-secondary hover:text-content" />
          )}
        </button>
      )}
      <span className="text-content-tertiary flex-shrink-0">
        {formatTime(event.timestamp)}
      </span>
    </div>
  );
};

/**
 * Render a grouped set of consecutive events
 */
const ConsecutiveGroupItem: React.FC<{
  group: ConsecutiveEventGroup;
  groupIndex: number;
  expandedGroups: Set<number>;
  onToggleGroup: (index: number) => void;
}> = ({ group, groupIndex, expandedGroups, onToggleGroup }) => {
  const isExpanded = expandedGroups.has(groupIndex);

  // Single item - render directly without group wrapper
  if (group.count === 1) {
    return <ToolEventItem event={group.events[0]} />;
  }

  // Multiple items - render as collapsible group
  return (
    <div className="space-y-1">
      <button
        onClick={() => onToggleGroup(groupIndex)}
        className="flex items-center gap-2 px-2 py-1.5 bg-zinc-800/30 hover:bg-zinc-700/40 rounded text-xs w-full text-left transition-colors"
      >
        <ChevronIcon className="w-3 h-3 text-content-tertiary" expanded={isExpanded} />
        <span className="text-accent-blue font-mono flex-shrink-0">
          {group.toolName}
        </span>
        <span className="bg-zinc-600 text-content text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
          {group.count}
        </span>
        <span className="text-content-tertiary truncate flex-1">
          {getTruncatedInput(group.events[0].toolInput)}
        </span>
      </button>
      {isExpanded && (
        <div className="pl-4 space-y-1">
          {group.events.map((event) => (
            <ToolEventItem key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
};

export const ActionStrip: React.FC<ActionStripProps> = ({
  summary,
  expanded,
  onToggle,
  toolEvents,
}) => {
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const totalCount = getTotalToolCount(summary);

  if (totalCount === 0) {
    return null;
  }

  const handleToggleGroup = (index: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  return (
    <div className="my-2">
      {/* Collapsed Strip */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 bg-zinc-800/50 hover:bg-zinc-700/50 rounded-md transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <StatusIndicator status={summary.status} />
          <div className="flex items-center gap-3 flex-wrap">
            <ToolBadge
              icon={<SearchIcon className="w-3.5 h-3.5" />}
              label="searches"
              count={summary.searches}
            />
            <ToolBadge
              icon={<FileIcon className="w-3.5 h-3.5" />}
              label="reads"
              count={summary.reads}
            />
            <ToolBadge
              icon={<PencilIcon className="w-3.5 h-3.5" />}
              label="writes"
              count={summary.writes}
            />
            <ToolBadge
              icon={<TerminalIcon className="w-3.5 h-3.5" />}
              label="commands"
              count={summary.commands}
            />
            <ToolBadge
              icon={<ListIcon className="w-3.5 h-3.5" />}
              label="tasks"
              count={summary.tasks}
            />
            <ToolBadge
              icon={<ToolIcon className="w-3.5 h-3.5" />}
              label="other"
              count={summary.other}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-content-secondary">
          <span>{totalCount} action{totalCount !== 1 ? 's' : ''}</span>
          <ChevronIcon className="w-4 h-4" expanded={expanded} />
        </div>
      </button>

      {/* Expanded View */}
      {expanded && (
        <div className="mt-2 space-y-1 pl-2 border-l-2 border-zinc-700">
          {/* Group consecutive events from original timeline order to preserve true consecutiveness */}
          {groupConsecutiveEvents(toolEvents).map((group, index) => (
            <ConsecutiveGroupItem
              key={`group-${index}`}
              group={group}
              groupIndex={index}
              expandedGroups={expandedGroups}
              onToggleGroup={handleToggleGroup}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ActionStrip;
