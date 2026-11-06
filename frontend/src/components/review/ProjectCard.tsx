/**
 * ProjectCard — Direction C card for the All Projects overview grid
 * (see `direction-c.jsx` C_AllProjects grid, lines 1300-1353).
 */

import type { CSSProperties, MouseEvent } from 'react';
import type { Project } from '@/types';
import { SevChip } from './primitives';

export interface ProjectCardData {
  project: Project;
  branchCount: number;
  prCount: number;
  high: number;
  med: number;
  low: number;
  relativeTime: string;
  /** risk-highest | pending | quiet */
  presence: 'risk' | 'pending' | 'quiet';
  /** auto-review currently running on N branches */
  autoCount: number;
}

interface ProjectCardProps {
  data: ProjectCardData;
  onOpen: (projectId: string) => void;
  onContextMenu?: (project: Project, event: MouseEvent<HTMLDivElement>) => void;
  selected?: boolean;
  onFocusProject?: (project: Project) => void;
}

function presenceDotColor(presence: ProjectCardData['presence']): string {
  if (presence === 'risk') return 'var(--sev-high)';
  if (presence === 'pending') return 'var(--sev-med)';
  return 'var(--text-tertiary)';
}

function findingsColor(high: number, med: number, low: number): string {
  if (high > 0) return 'var(--sev-high)';
  if (med > 0) return 'var(--sev-med)';
  if (low > 0) return 'var(--text-tertiary)';
  return 'var(--sev-ok)';
}

export function ProjectCard({ data, onOpen, onContextMenu, selected = false, onFocusProject }: ProjectCardProps) {
  const { project, branchCount, prCount, high, med, low, relativeTime, presence, autoCount } = data;
  const total = high + med + low;
  const cardStyle: CSSProperties = {
    background: selected ? 'var(--bg-surface-raised)' : 'var(--bg-surface)',
    border: selected ? '1px solid var(--border-default)' : '1px solid var(--review-shell-divider)',
    borderRadius: 6,
    padding: 16,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    transition: 'border-color var(--transition-fast), background var(--transition-fast)',
    fontFamily: 'var(--font-sans)',
  };

  return (
    <div
      role="button"
      tabIndex={0}
      data-overview-item-id={project.id}
      onClick={() => onOpen(project.id)}
      onFocus={() => onFocusProject?.(project)}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(project, e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(project.id);
        }
      }}
      style={cardStyle}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-default)';
        e.currentTarget.style.background = 'var(--bg-surface-raised)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = selected ? 'var(--border-default)' : 'var(--review-shell-divider)';
        e.currentTarget.style.background = selected ? 'var(--bg-surface-raised)' : 'var(--bg-surface)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: presenceDotColor(presence),
            marginTop: 6,
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              letterSpacing: -0.1,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {project.name}
          </div>
          {project.path && (
            <div
              style={{
                fontSize: 10.5,
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono)',
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {project.path}
            </div>
          )}
        </div>
        <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
          {relativeTime}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, fontSize: 11 }}>
        <StatBlock label="Branches" value={branchCount} />
        <StatBlock label="PRs" value={prCount} />
        <div style={{ flex: 1 }} />
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              fontWeight: 500,
            }}
          >
            Findings
          </div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              marginTop: 2,
              color: findingsColor(high, med, low),
            }}
          >
            {total === 0 ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                {'\u2713'} Clean
              </span>
            ) : (
              total
            )}
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 4,
          alignItems: 'center',
          paddingTop: 10,
          borderTop: '1px solid var(--review-shell-divider)',
          flexWrap: 'wrap',
        }}
      >
        {high > 0 && <SevChip level="HIGH" count={high} />}
        {med > 0 && <SevChip level="MED" count={med} />}
        {low > 0 && <SevChip level="LOW" count={low} />}
        {total === 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>No open findings</span>
        )}
        <div style={{ flex: 1 }} />
        {autoCount > 0 && (
          <span
            style={{
              fontSize: 10.5,
              color: 'var(--text-tertiary)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 5,
                height: 5,
                borderRadius: 3,
                background: 'var(--accent-blue)',
                boxShadow: '0 0 5px var(--accent-blue)',
              }}
            />
            {autoCount} auto
          </span>
        )}
      </div>
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          marginTop: 2,
          color: 'var(--text-primary)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
