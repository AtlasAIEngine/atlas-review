/**
 * PlanModePanel Component
 * Displays Claude's proposed plan with task list and approval controls
 * Shows real-time task progress during plan execution
 */

import React, { useState } from 'react';
import type { Task, TaskStatus } from './TaskListPanel';

type PlanStatus = 'pending_approval' | 'approved' | 'executing' | 'completed' | 'rejected';

interface Plan {
  id: string;
  title: string;
  summary: string;
  tasks: string[];
  status: PlanStatus;
}

interface PlanModePanelProps {
  plan: Plan;
  tasks?: Task[];
  isExecuting?: boolean;
  onApprove: () => void;
  onReject: () => void;
}

/**
 * Status icon component for task items
 */
const TaskStatusIcon: React.FC<{ status: TaskStatus }> = ({ status }) => {
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

export const PlanModePanel: React.FC<PlanModePanelProps> = ({
  plan,
  tasks = [],
  isExecuting = false,
  onApprove,
  onReject,
}) => {
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);

  const handleApprove = () => {
    setIsApproving(true);
    onApprove();
  };

  const handleReject = () => {
    setIsRejecting(true);
    onReject();
  };

  // Determine if buttons should be disabled
  const buttonsDisabled = isApproving || isRejecting || isExecuting;

  // Calculate progress statistics
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const totalCount = tasks.length > 0 ? tasks.length : plan.tasks.length;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  const allTasksCompleted = completedCount === totalCount && totalCount > 0;

  // Get task status from tasks array by index
  const getTaskStatus = (index: number): TaskStatus => {
    if (tasks.length === 0) return 'pending';
    return tasks[index]?.status || 'pending';
  };

  // Get status badge based on current state
  const getStatusBadge = () => {
    if (allTasksCompleted && isExecuting) {
      return (
        <span className="px-2 py-1 text-xs font-medium bg-green-900/60 text-green-200 rounded flex items-center gap-1.5">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Complete
        </span>
      );
    }
    if (isExecuting) {
      return (
        <span className="px-2 py-1 text-xs font-medium bg-blue-900/60 text-blue-200 rounded flex items-center gap-1.5">
          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
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
          Executing...
        </span>
      );
    }
    if (plan.status === 'approved' || isApproving) {
      return (
        <span className="px-2 py-1 text-xs font-medium bg-green-900/60 text-green-200 rounded">
          Approved
        </span>
      );
    }
    return (
      <span className="px-2 py-1 text-xs font-medium bg-yellow-900/60 text-yellow-200 rounded">
        Awaiting Approval
      </span>
    );
  };

  return (
    <div className="bg-surface-base border border-blue-700/60 rounded-lg overflow-hidden shadow-lg">
      {/* Header with status indicator */}
      <div className="px-4 py-3 bg-surface border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg
            className="w-5 h-5 text-accent-blue"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
            />
          </svg>
          <h2 className="text-lg font-semibold text-content">{plan.title}</h2>
        </div>
        {getStatusBadge()}
      </div>

      {/* Plan content */}
      <div className="p-4">
        {/* Summary */}
        {plan.summary && (
          <p className="text-sm text-content mb-4 leading-relaxed">
            {plan.summary}
          </p>
        )}

        {/* Progress bar - only show during or after execution */}
        {isExecuting && (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-content-secondary uppercase tracking-wide">
                Progress
              </span>
              <span className="text-sm text-content-secondary">
                {completedCount} of {totalCount} completed
              </span>
            </div>
            <div className="h-2 bg-surface-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-accent-green transition-all duration-500 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Task list */}
        <div className="mb-4">
          <h3 className="text-sm font-medium text-content-secondary mb-2 uppercase tracking-wide">
            Tasks ({plan.tasks.length})
          </h3>
          <ul className="space-y-2">
            {plan.tasks.map((taskName, index) => {
              const status = getTaskStatus(index);
              const isInProgress = status === 'in_progress';
              const isCompleted = status === 'completed';

              // Determine styles based on status
              const bgClass = isInProgress
                ? 'bg-blue-900/30 border border-blue-700/50'
                : isCompleted
                ? 'bg-surface/30 border border-border/30'
                : 'bg-surface/50 border border-transparent';

              const textClass = isCompleted
                ? 'text-content-secondary line-through'
                : isInProgress
                ? 'text-blue-200'
                : 'text-content';

              return (
                <li
                  key={index}
                  className={`flex items-start gap-3 text-sm rounded-lg p-2.5 transition-all duration-300 ${bgClass}`}
                >
                  {isExecuting ? (
                    <TaskStatusIcon status={status} />
                  ) : (
                    <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-full bg-surface-elevated text-content-secondary text-xs font-mono">
                      {index + 1}
                    </span>
                  )}
                  <span className={`flex-1 leading-relaxed ${textClass}`}>
                    {taskName}
                  </span>
                  {isInProgress && (
                    <span className="text-xs text-accent-blue font-medium">
                      Running...
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* Plan Complete message */}
        {allTasksCompleted && isExecuting && (
          <div className="flex items-center gap-2 p-3 bg-green-900/30 border border-green-700/50 rounded-lg mb-4">
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
              Plan Complete! All tasks finished successfully.
            </span>
          </div>
        )}

        {/* Approval buttons - hide when executing */}
        {!isExecuting && (
          <div className="flex items-center gap-3 pt-3 border-t border-border">
            <button
              onClick={handleApprove}
              disabled={buttonsDisabled}
              className="flex-1 px-4 py-2 bg-accent-green hover:bg-accent-green/80 disabled:bg-green-800 disabled:opacity-50 text-content font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {isApproving ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
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
                  Approving...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  Approve Plan
                </>
              )}
            </button>
            <button
              onClick={handleReject}
              disabled={buttonsDisabled}
              className="px-4 py-2 bg-transparent border border-border-strong hover:border-accent-red hover:text-accent-red disabled:opacity-50 text-content font-medium rounded-lg transition-colors flex items-center gap-2"
            >
              {isRejecting ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
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
                  Rejecting...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                  Reject
                </>
              )}
            </button>
          </div>
        )}

        {/* Execution progress indicator - show only if not all completed */}
        {isExecuting && !allTasksCompleted && (
          <div className="pt-3 border-t border-border">
            <div className="flex items-center gap-2 text-sm text-blue-300">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
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
              <span>Executing plan... Claude is working on the tasks.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PlanModePanel;
