/**
 * TaskListPanel Component
 * Displays a list of tasks with real-time status indicators
 * Used during plan execution to show task progress
 */

import React from 'react';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface Task {
  id: string;
  name: string;
  status: TaskStatus;
}

interface TaskListPanelProps {
  tasks: Task[];
  currentTaskId?: string;
}

/**
 * Status icon component that shows different icons based on task state
 */
const StatusIcon: React.FC<{ status: TaskStatus }> = ({ status }) => {
  switch (status) {
    case 'completed':
      return (
        <svg
          className="w-5 h-5 text-accent-green"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M5 13l4 4L19 7"
          />
        </svg>
      );
    case 'in_progress':
      return (
        <svg className="w-5 h-5 text-accent-blue animate-spin" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
            fill="none"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      );
    case 'pending':
    default:
      return (
        <div className="w-5 h-5 rounded-full border-2 border-content-tertiary" />
      );
  }
};

/**
 * Individual task item with status indicator
 */
const TaskItem: React.FC<{ task: Task; isCurrent: boolean }> = ({
  task,
  isCurrent: _isCurrent,
}) => {
  const bgClass =
    task.status === 'in_progress'
      ? 'bg-blue-900/30 border-blue-700/50'
      : task.status === 'completed'
      ? 'bg-surface/30 border-border/30'
      : 'bg-surface/50 border-border/30';

  const textClass =
    task.status === 'completed'
      ? 'text-content-secondary line-through'
      : task.status === 'in_progress'
      ? 'text-blue-200'
      : 'text-content';

  return (
    <div
      className={`flex items-center gap-3 p-2.5 rounded-lg border transition-all duration-300 ${bgClass}`}
    >
      <StatusIcon status={task.status} />
      <span className={`flex-1 text-sm leading-relaxed ${textClass}`}>
        {task.name}
      </span>
      {task.status === 'in_progress' && (
        <span className="text-xs text-accent-blue font-medium">Running...</span>
      )}
    </div>
  );
};

/**
 * TaskListPanel - Main component showing task progress
 */
export const TaskListPanel: React.FC<TaskListPanelProps> = ({
  tasks,
  currentTaskId,
}) => {
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const totalCount = tasks.length;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  if (tasks.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {/* Progress header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-content-secondary uppercase tracking-wide">
          Task Progress
        </h3>
        <span className="text-sm text-content-secondary">
          {completedCount} of {totalCount} completed
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-surface-elevated rounded-full overflow-hidden">
        <div
          className="h-full bg-accent-green transition-all duration-500 ease-out"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Task list */}
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id}>
            <TaskItem task={task} isCurrent={task.id === currentTaskId} />
          </li>
        ))}
      </ul>

      {/* All complete message */}
      {completedCount === totalCount && totalCount > 0 && (
        <div className="flex items-center gap-2 p-2 bg-green-900/30 border border-green-700/50 rounded-lg">
          <svg
            className="w-5 h-5 text-accent-green"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span className="text-sm text-green-300 font-medium">
            All tasks completed!
          </span>
        </div>
      )}
    </div>
  );
};

export default TaskListPanel;
