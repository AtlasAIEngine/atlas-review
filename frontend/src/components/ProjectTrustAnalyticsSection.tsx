import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@/types';
import TrustAnalyticsDashboard from './TrustAnalyticsDashboard';

interface ProjectTrustAnalyticsSectionProps {
  projects: Project[];
  refreshKey?: number;
}

function ProjectTrustAnalyticsSection({
  projects,
  refreshKey = 0,
}: ProjectTrustAnalyticsSectionProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const sortedProjects = useMemo(() => (
    [...projects].sort((a, b) => {
      const dateA = new Date(a.lastModified || a.lastAccessed || a.updatedAt || a.createdAt).getTime();
      const dateB = new Date(b.lastModified || b.lastAccessed || b.updatedAt || b.createdAt).getTime();
      return dateB - dateA;
    })
  ), [projects]);

  useEffect(() => {
    if (sortedProjects.length === 0) {
      setSelectedProjectId(null);
      return;
    }
    setSelectedProjectId((current) => (
      current && sortedProjects.some((project) => project.id === current)
        ? current
        : sortedProjects[0].id
    ));
  }, [sortedProjects]);

  const selectedProject = sortedProjects.find((project) => project.id === selectedProjectId) || null;
  if (!selectedProject) return null;

  return (
    <section style={{ marginTop: 'var(--space-8)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h3 style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Review Analytics
          </h3>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', margin: 'var(--space-1) 0 0' }}>
            Project-level review speed, coverage, and trust signals.
          </p>
        </div>
        {sortedProjects.length > 1 && (
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Project
            </span>
            <select
              value={selectedProject.id}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              style={{
                minWidth: 220,
                background: 'var(--review-code-bg)',
                color: 'var(--text-primary)',
                border: '1px solid var(--review-shell-border)',
                borderRadius: 10,
                padding: 'var(--space-2) var(--space-3)',
                fontSize: 'var(--text-sm)',
                fontFamily: 'var(--font-sans)',
                outline: 'none',
              }}
            >
              {sortedProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div style={{
        background: 'var(--review-card-bg)',
        border: '1px solid var(--review-shell-border)',
        borderRadius: 16,
        boxShadow: 'var(--review-panel-shadow)',
        overflow: 'hidden',
      }}>
        <TrustAnalyticsDashboard projectId={selectedProject.id} refreshKey={refreshKey} />
      </div>
    </section>
  );
}

export default ProjectTrustAnalyticsSection;
