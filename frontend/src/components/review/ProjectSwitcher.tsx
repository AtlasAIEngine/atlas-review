/**
 * ProjectSwitcher — Direction C top-bar dropdown (see `direction-c.jsx`
 * lines 237–330). Click the current project label to open a 360px
 * searchable list with a footer row for "All projects overview" and
 * "Add project from folder…".
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '@/types';
import { Kbd, SevChip } from './primitives';

export interface SwitcherProject extends Project {
  severity?: { high: number; med: number };
  /**
   * Per-project review presence marker. Named `presence` (not `status`)
   * to avoid colliding with `Project.status` ('active' | 'archived' |
   * 'deleted'), which is a backend lifecycle field.
   */
  presence?: 'risk' | 'pending' | 'quiet';
}

interface ProjectSwitcherProps {
  currentProject: Project | null;
  projects: SwitcherProject[];
  onPick: (project: Project) => void;
  onAllProjects: () => void;
  onAddFromFolder?: () => void;
}

function presenceDotColor(presence: SwitcherProject['presence']): string {
  if (presence === 'risk') return 'var(--sev-high)';
  if (presence === 'pending') return 'var(--sev-med)';
  return 'var(--text-tertiary)';
}

export function ProjectSwitcher({
  currentProject,
  projects,
  onPick,
  onAllProjects,
  onAddFromFolder,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const safe = Array.isArray(projects) ? projects : [];
    if (!q) return safe;
    return safe.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, query]);

  const label = currentProject?.name || 'Select project';

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        type="button"
        onClick={() => onAllProjects()}
        aria-label="Back to all projects"
        title="Back to all projects"
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-tertiary)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          padding: 2,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="10 3 5 8 10 13" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          padding: '4px 8px',
          borderRadius: 4,
          background: open ? 'var(--bg-surface-raised)' : 'transparent',
          border: `1px solid ${open ? 'var(--border-default)' : 'transparent'}`,
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-ui)',
        }}
      >
        {label}
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
          <polyline points="3 5 6 8 9 5" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            width: 360,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            borderRadius: 6,
            boxShadow: 'var(--review-card-shadow-strong)',
            zIndex: 100,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '8px 10px',
              borderBottom: '1px solid var(--review-shell-divider)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
              <circle cx="7" cy="7" r="4.5" />
              <line x1="10.5" y1="10.5" x2="14" y2="14" />
            </svg>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Switch project…"
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                fontSize: 12,
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-ui)',
              }}
            />
            <Kbd>{'\u2318'}P</Kbd>
          </div>

          <div style={{ maxHeight: 280, overflow: 'auto', padding: '4px 0' }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 14, fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>
                No projects match “{query}”
              </div>
            ) : (
              filtered.map((p) => {
                const isCurrent = currentProject?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { onPick(p); setOpen(false); }}
                    style={{
                      padding: '8px 12px',
                      display: 'grid',
                      gridTemplateColumns: '8px 1fr auto',
                      gap: 10,
                      alignItems: 'center',
                      cursor: 'pointer',
                      background: isCurrent
                        ? 'color-mix(in oklab, var(--accent-blue) 8%, transparent)'
                        : 'transparent',
                      border: 'none',
                      width: '100%',
                      textAlign: 'left',
                      fontFamily: 'var(--font-ui)',
                    }}
                    onMouseEnter={(e) => {
                      if (!isCurrent) e.currentTarget.style.background = 'var(--bg-hover)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isCurrent) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        background: presenceDotColor(p.presence),
                      }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: isCurrent ? 600 : 500, color: 'var(--text-primary)' }}>
                        {p.name}
                      </div>
                      {p.path && (
                        <div
                          style={{
                            fontSize: 10.5,
                            color: 'var(--text-tertiary)',
                            fontFamily: 'var(--font-mono)',
                            marginTop: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {p.path}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {/* Only show severity / clean state when we actually have
                          per-project review data. Today that's the
                          currently-open project; other projects render no
                          chip rather than a misleading "✓ clean" check. */}
                      {p.severity && p.severity.high > 0 && <SevChip level="HIGH" count={p.severity.high} />}
                      {p.severity && p.severity.med > 0 && <SevChip level="MED" count={p.severity.med} />}
                      {p.severity && p.severity.high === 0 && p.severity.med === 0 && (
                        <span style={{ fontSize: 10.5, color: 'var(--sev-ok)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          {'\u2713'}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--review-shell-divider)', padding: 4 }}>
            <button
              type="button"
              onClick={() => { onAllProjects(); setOpen(false); }}
              style={{
                padding: '8px 12px',
                borderRadius: 3,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: 'var(--text-primary)',
                background: 'transparent',
                border: 'none',
                width: '100%',
                textAlign: 'left',
                fontFamily: 'var(--font-ui)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
                <path d="M1.5 4.5h5L8 3h6.5v9.5h-13z" />
              </svg>
              All projects overview
              <div style={{ flex: 1 }} />
              <Kbd>{'\u2318'}{'\u21E7'}P</Kbd>
            </button>
            {onAddFromFolder && (
              <button
                type="button"
                onClick={() => { onAddFromFolder(); setOpen(false); }}
                style={{
                  padding: '8px 12px',
                  borderRadius: 3,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  background: 'transparent',
                  border: 'none',
                  width: '100%',
                  textAlign: 'left',
                  fontFamily: 'var(--font-ui)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="3" x2="8" y2="13" />
                  <line x1="3" y1="8" x2="13" y2="8" />
                </svg>
                Add project from folder…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
