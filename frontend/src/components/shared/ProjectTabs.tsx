/**
 * Shared ProjectTabs component
 * Renders "Recent Projects" / "All Projects (N)" tabs with a project card grid.
 * Used by both HomePage (build context) and TrustDashboard (review context).
 */

import { useState } from 'react';
import type { Project } from '@/types';
import { ProjectCard, type ProjectTrustSummary } from './ProjectCard';
const RECENT_COUNT = 6;

interface ProjectTabsProps {
  projects: Project[];
  trustSummaries: Record<string, ProjectTrustSummary>;
  loadingSummaries: boolean;
  loadingSummaryProjectIds?: Set<string>;
  context: 'review' | 'build';
  onClickProject: (project: Project) => void;
  onSecondaryAction?: (project: Project) => { label: string; onClick: () => void };
  onRemove?: (project: Project, e: React.MouseEvent) => void;
  /** Optional card(s) rendered first in the grid on every tab (e.g. an optimistic pending card) */
  prefixCards?: React.ReactNode;
}

type Tab = 'recent' | 'all';

export default function ProjectTabs({
  projects,
  trustSummaries,
  loadingSummaries: _loadingSummaries,
  loadingSummaryProjectIds,
  context,
  onClickProject,
  onSecondaryAction,
  onRemove,
  prefixCards,
}: ProjectTabsProps) {
  const [activeTab, setActiveTab] = useState<Tab>('recent');

  if (projects.length === 0 && !prefixCards) return null;

  const recentProjects = projects.slice(0, RECENT_COUNT);
  const displayedProjects = activeTab === 'recent' ? recentProjects : projects;

  return (
    <div>
      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-4)',
          borderBottom: '1px solid var(--review-shell-divider)',
          marginBottom: 'var(--space-5)',
        }}
      >
        <TabButton
          active={activeTab === 'recent'}
          onClick={() => setActiveTab('recent')}
        >
          Recent Projects
        </TabButton>
        <TabButton
          active={activeTab === 'all'}
          onClick={() => setActiveTab('all')}
        >
          All Projects{' '}
          <span style={{ color: 'var(--text-quaternary)', fontWeight: 700 }}>
            {projects.length}
          </span>
        </TabButton>
      </div>

      {/* Project grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {prefixCards}
        {displayedProjects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            summary={trustSummaries[project.id]}
            loadingSummary={loadingSummaryProjectIds?.has(project.id) || false}
            context={context}
            onClick={() => onClickProject(project)}
            onSecondaryAction={onSecondaryAction?.(project)}
            onRemove={onRemove ? (e: React.MouseEvent) => onRemove(project, e) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid var(--text-primary)' : '2px solid transparent',
        padding: '0 0 var(--space-2)',
        marginBottom: '-1px',
        borderRadius: 0,
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 700,
        color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
        transition: 'color var(--transition-fast), border-color var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = 'var(--text-secondary)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = 'var(--text-tertiary)';
      }}
    >
      {children}
    </button>
  );
}
