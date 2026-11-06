/**
 * AllProjectsOverview — Direction C all-projects landing surface
 * (see `direction-c.jsx` C_AllProjects, lines 1246-1372).
 *
 * Header with page title + search + GitHub + Add actions, aggregate
 * metrics strip (4 tiles), and a 3-column responsive project grid.
 *
 * Replaces the previous TrustDashboard render for the Trust Pipeline
 * landing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { branchReviewApi, prReviewApi, projectApi, reviewApi, settingsApi } from '@/services/api';
import type { BranchReview, PrReview, Project, ReviewRecommendation } from '@/types';
import { ENABLE_BUILDER } from '@/featureFlags';
import toast from '@/lib/toast';
import { isTauriEnvironment } from '@/utils/tauri';
import {
  AUTO_REVIEW_SETTING_CHANGED_EVENT,
  type AutoReviewSettingChangedDetail,
} from '@/constants/autoReviewEvents';
import { Btn } from './review/primitives';
import { ProjectCard, type ProjectCardData } from './review/ProjectCard';
import { ContextMenu } from './shared/ContextMenu';
import { ConfirmDialog } from './shared/ConfirmDialog';
import {
  getRecommendationResolutionFor,
  normalizeRecommendationResolutionMap,
  type RecommendationResolutionMap,
} from './review/reviewPanelUtils';

interface AllProjectsOverviewProps {
  onOpenProject: (projectId: string) => void;
  onOpenLocalFolder: () => void;
  onGitHubImport: () => void;
  onCreateProject?: () => void;
  pendingProjectPath?: string | null;
  refreshKey?: number;
}

function countSeverities(
  recommendations: ReviewRecommendation[] | undefined,
  resolutions?: RecommendationResolutionMap,
): { high: number; med: number; low: number } {
  const safe = Array.isArray(recommendations) ? recommendations : [];
  let high = 0;
  let med = 0;
  let low = 0;
  for (const r of safe) {
    if (r?.type && r.type !== 'issue') continue;
    if (resolutions && getRecommendationResolutionFor(r, resolutions)) continue;
    const sev = String(r?.severity || '').toLowerCase();
    if (sev === 'high' || sev === 'critical') high += 1;
    else if (sev === 'medium' || sev === 'med') med += 1;
    else if (sev === 'low') low += 1;
  }
  return { high, med, low };
}

function relativeTimeLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.round(d / 30);
  return `${mo}mo`;
}

function latestActivityIso(brs: BranchReview[] | undefined, prs: PrReview[] | undefined): string | null {
  const safeBrs = Array.isArray(brs) ? brs : [];
  const safePrs = Array.isArray(prs) ? prs : [];
  const all = [
    ...safeBrs.map((b) => b.updatedAt),
    ...safePrs.map((p) => p.updatedAt),
  ].filter(Boolean) as string[];
  if (all.length === 0) return null;
  return all.sort().slice(-1)[0] ?? null;
}

function isTrackedBranchReview(br: BranchReview): boolean {
  return br.status === 'active' || br.status === 'stale';
}

function isLastCommitFallback(br: BranchReview): boolean {
  return typeof br.baseBranch === 'string' && br.baseBranch.endsWith('~last-commit');
}

function isBaseLikeBranch(branchName: string, projectBaseBranch: string | null | undefined): boolean {
  const name = branchName.trim();
  const lower = name.toLowerCase();
  const base = String(projectBaseBranch || '').trim().toLowerCase();
  if (!name) return true;
  if (base && lower === base) return true;
  return lower === 'main'
    || lower === 'master'
    || lower === 'develop'
    || lower === 'development'
    || lower === 'staging'
    || lower === 'release'
    || lower.startsWith('release/');
}

function countRecentBranchRows(
  tracked: BranchReview[],
  localBranches: Array<{ name?: string; current?: boolean; isWorktree?: boolean; aheadCount?: number | null }> | undefined,
  project: Project,
): number {
  const trackedNonBase = tracked.filter((br) => (
    isLastCommitFallback(br)
    || !isBaseLikeBranch(br.branchName, project.baseBranchDisplay)
  ));
  const trackedNames = new Set(trackedNonBase.map((branch) => branch.branchName));
  const candidates = (Array.isArray(localBranches) ? localBranches : [])
    .map((branch) => ({
      name: String(branch?.name || '').trim(),
      current: Boolean(branch?.current),
      isWorktree: Boolean(branch?.isWorktree),
      aheadCount: typeof branch?.aheadCount === 'number' ? branch.aheadCount : null,
    }))
    .filter((branch) => (
      branch.name
      && (
        branch.current
        || branch.isWorktree
        || (branch.aheadCount != null && branch.aheadCount > 0)
      )
      && !trackedNames.has(branch.name)
      && !isBaseLikeBranch(branch.name, project.baseBranchDisplay)
    ));
  return trackedNonBase.length + candidates.length;
}

function createProjectCardFallback(project: Project): ProjectCardData {
  return {
    project,
    branchCount: 0,
    prCount: 0,
    high: 0,
    med: 0,
    low: 0,
    relativeTime: relativeTimeLabel(project.updatedAt),
    presence: 'quiet',
    autoCount: 0,
  };
}

function AllProjectsOverview({
  onOpenProject,
  onOpenLocalFolder,
  onGitHubImport,
  onCreateProject,
  pendingProjectPath,
  refreshKey = 0,
}: AllProjectsOverviewProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState('');
  const [cardsByProject, setCardsByProject] = useState<Record<string, ProjectCardData>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; project: Project } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Project | null>(null);
  const [selectedOverviewItemId, setSelectedOverviewItemId] = useState<string | null>(null);
  const projectGridRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    settingsApi.get('auto_review_enabled').then((res) => {
      if (cancelled) return;
      setAutoReviewEnabled(String(res?.value ?? 'true').toLowerCase() !== 'false');
    }).catch(() => {
      if (!cancelled) setAutoReviewEnabled(true);
    });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    const handleAutoReviewChanged = (event: Event) => {
      const detail = (event as CustomEvent<AutoReviewSettingChangedDetail>).detail;
      if (typeof detail?.enabled !== 'boolean') return;
      setAutoReviewEnabled(detail.enabled);
    };
    window.addEventListener(AUTO_REVIEW_SETTING_CHANGED_EVENT, handleAutoReviewChanged);
    return () => window.removeEventListener(AUTO_REVIEW_SETTING_CHANGED_EVENT, handleAutoReviewChanged);
  }, []);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await projectApi.list();
      const list = Array.isArray(res.projects) ? res.projects : [];
      setProjects(list);
    } catch (err) {
      setProjects([]);
      setLoadError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadProjects(); }, [loadProjects, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    async function fetchCards() {
      const next: Record<string, ProjectCardData> = {};
      await Promise.allSettled(
        projects.map(async (project) => {
          try {
            const [brRes, prRes, branchListRes] = await Promise.allSettled([
              branchReviewApi.list(project.id),
              prReviewApi.list(project.id),
              branchReviewApi.listBranches(project.id),
            ]);
            const brs = brRes.status === 'fulfilled' ? (brRes.value.branchReviews || []) : [];
            const prs = prRes.status === 'fulfilled' ? (prRes.value.prReviews || []) : [];
            const localBranches = branchListRes.status === 'fulfilled' ? branchListRes.value.branches : undefined;

            const active = brs.filter(isTrackedBranchReview);
            const branchCount = countRecentBranchRows(active, localBranches, project);
            const openPrs = prs.filter((p) => p.state !== 'closed' && p.state !== 'merged');

            const outcomeScopes: Array<
              { kind: 'branch_review' | 'pr_review'; reviewId: string }
            > = [];
            for (const b of active) {
              if (Array.isArray(b.reviewJson?.recommendations) && b.reviewJson!.recommendations.length > 0) {
                outcomeScopes.push({ kind: 'branch_review', reviewId: b.id });
              }
            }
            for (const p of openPrs) {
              if (Array.isArray(p.reviewJson?.recommendations) && p.reviewJson!.recommendations.length > 0) {
                outcomeScopes.push({ kind: 'pr_review', reviewId: p.id });
              }
            }
            const outcomeResults = await Promise.allSettled(
              outcomeScopes.map((scope) => reviewApi.getOutcomes(project.id, {
                reviewType: scope.kind,
                reviewId: scope.reviewId,
              })),
            );
            const outcomesByReviewId = new Map<string, RecommendationResolutionMap>();
            outcomeResults.forEach((result, idx) => {
              if (result.status !== 'fulfilled') return;
              const scope = outcomeScopes[idx];
              outcomesByReviewId.set(
                scope.reviewId,
                normalizeRecommendationResolutionMap(result.value.byRecommendationKey),
              );
            });

            const tally = { high: 0, med: 0, low: 0 };
            for (const b of active) {
              const t = countSeverities(b.reviewJson?.recommendations, outcomesByReviewId.get(b.id));
              tally.high += t.high;
              tally.med += t.med;
              tally.low += t.low;
            }
            for (const p of openPrs) {
              const t = countSeverities(p.reviewJson?.recommendations, outcomesByReviewId.get(p.id));
              tally.high += t.high;
              tally.med += t.med;
              tally.low += t.low;
            }

            const anyRunning = active.some((b) => b.reviewStatus === 'queued' || b.reviewStatus === 'reviewing')
              || openPrs.some((p) => p.reviewStatus === 'queued' || p.reviewStatus === 'reviewing');

            const presence: ProjectCardData['presence'] = tally.high > 0
              ? 'risk'
              : (tally.med > 0 || anyRunning)
                ? 'pending'
                : 'quiet';

            const autoCount = 0;

            next[project.id] = {
              project,
              branchCount,
              prCount: openPrs.length,
              high: tally.high,
              med: tally.med,
              low: tally.low,
              relativeTime: relativeTimeLabel(latestActivityIso(brs, prs) || project.updatedAt),
              presence,
              autoCount,
            };
          } catch {
            next[project.id] = {
              project,
              branchCount: 0,
              prCount: 0,
              high: 0,
              med: 0,
              low: 0,
              relativeTime: relativeTimeLabel(project.updatedAt),
              presence: 'quiet',
              autoCount: 0,
            };
          }
        }),
      );
      if (!cancelled) setCardsByProject(next);
    }
    if (projects.length === 0) {
      // Reset card map when the project list goes empty so aggregate
      // metrics don't keep stale totals from a previous list.
      setCardsByProject({});
      return () => { cancelled = true; };
    }
    void fetchCards();
    return () => { cancelled = true; };
  }, [projects]);

  const filteredCards = useMemo<ProjectCardData[]>(() => {
    const q = query.trim().toLowerCase();
    const safe = Array.isArray(projects) ? projects : [];
    return safe
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.path || '').toLowerCase().includes(q))
      .map((p) => cardsByProject[p.id] || createProjectCardFallback(p));
  }, [projects, query, cardsByProject]);

  const overviewItemIds = useMemo(() => {
    const ids = filteredCards.map((card) => card.project.id);
    if (projects.length > 0 || pendingProjectPath) ids.push('add-project');
    return ids;
  }, [filteredCards, pendingProjectPath, projects.length]);

  const selectedOverviewItem = useMemo(() => {
    if (selectedOverviewItemId && overviewItemIds.includes(selectedOverviewItemId)) {
      return selectedOverviewItemId;
    }
    return overviewItemIds[0] || null;
  }, [overviewItemIds, selectedOverviewItemId]);

  useEffect(() => {
    if (!selectedOverviewItemId) return;
    if (overviewItemIds.includes(selectedOverviewItemId)) return;
    setSelectedOverviewItemId(null);
  }, [overviewItemIds, selectedOverviewItemId]);

  const focusOverviewItem = useCallback((itemId: string) => {
    const focus = () => {
      const root = projectGridRef.current;
      const el = root?.querySelector<HTMLElement>(`[data-overview-item-id="${CSS.escape(itemId)}"]`);
      if (!el) return false;
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
      return true;
    };
    if (focus()) return;
    window.requestAnimationFrame(() => {
      if (focus()) return;
      window.setTimeout(() => {
        focus();
      }, 0);
    });
  }, []);

  const getGridColumnCount = useCallback(() => {
    const grid = projectGridRef.current;
    if (!grid) return 1;
    const columns = window.getComputedStyle(grid).gridTemplateColumns
      .split(' ')
      .filter(Boolean).length;
    return Math.max(1, columns || 1);
  }, []);

  const getActiveOverviewItemId = useCallback((activeElement: HTMLElement | null) => (
    activeElement
      ?.closest<HTMLElement>('[data-overview-item-id]')
      ?.getAttribute('data-overview-item-id') || null
  ), []);

  const shouldIgnoreOverviewShortcutTarget = useCallback((activeElement: HTMLElement | null) => {
    if (!activeElement) return false;
    if (getActiveOverviewItemId(activeElement)) return false;
    if (activeElement.isContentEditable) return true;

    const tag = activeElement.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;

    return Boolean(
      activeElement.closest('button, a, [role="button"], [role="menuitem"], [role="dialog"], [data-radix-popper-content-wrapper]')
    );
  }, [getActiveOverviewItemId]);

  const navigateOverviewItems = useCallback((fromItemId: string | null, delta: number) => {
    if (overviewItemIds.length === 0) return;
    const fromId = fromItemId || selectedOverviewItem || overviewItemIds[0];
    let currentIndex = overviewItemIds.findIndex((itemId) => itemId === fromId);
    if (currentIndex < 0) currentIndex = delta > 0 ? -1 : overviewItemIds.length;
    const nextIndex = Math.max(0, Math.min(overviewItemIds.length - 1, currentIndex + delta));
    const nextItemId = overviewItemIds[nextIndex];
    if (!nextItemId) return;
    setSelectedOverviewItemId(nextItemId);
    focusOverviewItem(nextItemId);
  }, [focusOverviewItem, overviewItemIds, selectedOverviewItem]);

  const openOverviewItem = useCallback((itemId: string | null) => {
    const targetId = itemId || selectedOverviewItem;
    if (!targetId) return;
    setSelectedOverviewItemId(targetId);
    if (targetId === 'add-project') {
      onOpenLocalFolder();
      return;
    }
    onOpenProject(targetId);
  }, [onOpenLocalFolder, onOpenProject, selectedOverviewItem]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.altKey) return;
      const isSearchShortcut = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.shiftKey;
      const isNavigateKey = !event.metaKey && !event.ctrlKey && !event.shiftKey && (
        event.key === 'j'
        || event.key === 'J'
        || event.key === 'k'
        || event.key === 'K'
        || event.key === 'ArrowUp'
        || event.key === 'ArrowDown'
        || event.key === 'ArrowLeft'
        || event.key === 'ArrowRight'
      );
      const isOpenKey = !event.metaKey && !event.ctrlKey && !event.shiftKey && (event.key === 'Enter' || event.key === ' ');
      if (!isSearchShortcut && !isNavigateKey && !isOpenKey) return;

      const activeElement = document.activeElement as HTMLElement | null;
      if (contextMenu || confirmRemove || shouldIgnoreOverviewShortcutTarget(activeElement)) return;

      if (isSearchShortcut) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      const activeItemId = getActiveOverviewItemId(activeElement);
      if (isOpenKey) {
        event.preventDefault();
        openOverviewItem(activeItemId);
        return;
      }

      const columns = getGridColumnCount();
      const delta =
        event.key === 'ArrowLeft' || event.key.toLowerCase() === 'j' ? -1
        : event.key === 'ArrowRight' || event.key.toLowerCase() === 'k' ? 1
        : event.key === 'ArrowUp' ? -columns
        : columns;
      event.preventDefault();
      navigateOverviewItems(activeItemId, delta);
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [confirmRemove, contextMenu, getActiveOverviewItemId, getGridColumnCount, navigateOverviewItems, openOverviewItem, shouldIgnoreOverviewShortcutTarget]);

  const totals = useMemo(() => {
    const safe = projects.map((project) => cardsByProject[project.id] || createProjectCardFallback(project));
    return {
      branches: safe.reduce((a, c) => a + c.branchCount, 0),
      prs: safe.reduce((a, c) => a + c.prCount, 0),
      high: safe.reduce((a, c) => a + c.high, 0),
      med: safe.reduce((a, c) => a + c.med, 0),
      low: safe.reduce((a, c) => a + c.low, 0),
      risk: safe.filter((c) => c.presence === 'risk').length,
    };
  }, [cardsByProject, projects]);

  const totalFindings = totals.high + totals.med + totals.low;

  const handleOpenProjectFolder = useCallback(async (project: Project) => {
    if (!project.path) return;
    if (isTauriEnvironment()) {
      try {
        const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
        await revealItemInDir(project.path);
        return;
      } catch {
        // Fall through to backend reveal.
      }
    }
    try {
      await projectApi.revealInFolder(project.id);
    } catch {
      try {
        await navigator.clipboard.writeText(project.path);
        toast.success('Project path copied to clipboard');
      } catch {
        toast.error('Failed to open project folder');
      }
    }
  }, []);

  const handleRemoveProject = useCallback(async (project: Project) => {
    try {
      await projectApi.delete(project.id);
      setProjects((prev) => prev.filter((entry) => entry.id !== project.id));
      setCardsByProject((prev) => {
        const next = { ...prev };
        delete next[project.id];
        return next;
      });
      toast.success('Project removed');
    } catch (err) {
      console.error('Failed to remove project:', err);
      toast.error('Failed to remove project');
    }
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        background: 'var(--review-shell-bg)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Row 1 — page toolbar */}
      <div
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          borderBottom: '1px solid var(--review-shell-divider)',
          gap: 10,
          flexShrink: 0,
          background: 'var(--review-panel-bg)',
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          / All projects
        </span>
        <div style={{ flex: 1 }} />
        <Btn variant="ghost" size="sm" onClick={onGitHubImport} aria-label="GitHub">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0a8 8 0 00-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.88-1.16-.88-1.16-.72-.49.06-.48.06-.48.79.06 1.21.82 1.21.82.71 1.21 1.86.86 2.31.66.07-.52.28-.86.5-1.06-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82A7.6 7.6 0 018 4.72c.68.003 1.37.092 2.01.27 1.52-1.04 2.19-.82 2.19-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.47v2.17c0 .21.15.46.55.38A8 8 0 008 0z" />
          </svg>
          GitHub
        </Btn>
        <Btn variant="primary" size="sm" onClick={onOpenLocalFolder}>
          + Add project
        </Btn>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '28px 32px 32px' }}>
        {/* Header row: title + search */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 12,
            marginBottom: 4,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: -0.4, color: 'var(--text-primary)' }}>
              Projects
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
              {projects.length} tracked · {totals.branches} branches · {totals.prs} PRs
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--review-shell-divider)',
              borderRadius: 4,
              minWidth: 240,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
              <circle cx="7" cy="7" r="4.5" />
              <line x1="10.5" y1="10.5" x2="14" y2="14" />
            </svg>
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter projects…"
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
          </div>
        </div>

        {loadError && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--sev-high)',
              background: 'var(--bg-surface)',
              border: '1px solid var(--review-shell-divider)',
              borderRadius: 5,
              padding: '10px 14px',
              margin: '16px 0',
            }}
          >
            {loadError}
          </div>
        )}

        {/* Aggregate strip */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 1,
            background: 'var(--review-shell-divider)',
            border: '1px solid var(--review-shell-divider)',
            borderRadius: 5,
            overflow: 'hidden',
            margin: '24px 0 28px',
          }}
        >
          <MetricTile
            k="Active branches"
            v={String(totals.branches)}
            sub={totals.risk > 0 ? `${totals.risk} need attention` : 'all healthy'}
          />
          <MetricTile
            k="Open PRs"
            v={String(totals.prs)}
            sub="across all repos"
          />
          <MetricTile
            k="Findings open"
            v={String(totalFindings)}
            sub={`${totals.high} high · ${totals.med} med · ${totals.low} low`}
            warn={totals.high > 0}
          />
          <MetricTile
            k="Auto-review"
            v={autoReviewEnabled ? 'On' : 'Off'}
            sub={autoReviewEnabled ? 'project opt-in' : 'enable in settings'}
          />
        </div>

        {/* Project grid */}
        {projects.length === 0 && !loading && !pendingProjectPath ? (
          <div
            style={{
              border: '1px dashed var(--review-shell-divider)',
              borderRadius: 6,
              padding: '48px 24px',
              textAlign: 'center',
              color: 'var(--text-tertiary)',
              fontSize: 13,
              background: 'var(--bg-surface)',
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              Add your first project
            </div>
            <div style={{ marginBottom: 16 }}>
              Open a local folder or connect a GitHub repository to start reviewing.
            </div>
            <div style={{ display: 'inline-flex', gap: 8 }}>
              <Btn variant="primary" size="sm" onClick={onOpenLocalFolder}>
                + Open local folder
              </Btn>
              <Btn variant="ghost" size="sm" onClick={onGitHubImport}>
                GitHub
              </Btn>
            </div>
          </div>
        ) : (
          <div
            ref={projectGridRef}
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 12,
            }}
          >
            {filteredCards.map((c) => (
              <ProjectCard
                key={c.project.id}
                data={c}
                onOpen={onOpenProject}
                selected={selectedOverviewItem === c.project.id}
                onFocusProject={(project) => setSelectedOverviewItemId(project.id)}
                onContextMenu={(project, e) => setContextMenu({ x: e.clientX, y: e.clientY, project })}
              />
            ))}
            {pendingProjectPath && (
              <PendingProjectCard path={pendingProjectPath} />
            )}
            {/* Add-project tile */}
            <div
              role="button"
              tabIndex={0}
              data-overview-item-id="add-project"
              onClick={() => onOpenLocalFolder()}
              onFocus={() => setSelectedOverviewItemId('add-project')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenLocalFolder();
                  return;
                }
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K') {
                  e.preventDefault();
                  const columns = getGridColumnCount();
                  const delta =
                    e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j' ? -1
                    : e.key === 'ArrowRight' || e.key.toLowerCase() === 'k' ? 1
                    : e.key === 'ArrowUp' ? -columns
                    : columns;
                  navigateOverviewItems('add-project', delta);
                }
              }}
              style={{
                border: selectedOverviewItem === 'add-project' ? '1px dashed var(--border-default)' : '1px dashed var(--review-shell-divider)',
                borderRadius: 6,
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                color: 'var(--text-tertiary)',
                fontSize: 12,
                cursor: 'pointer',
                minHeight: 160,
                background: selectedOverviewItem === 'add-project' ? 'var(--bg-surface)' : 'transparent',
                fontFamily: 'var(--font-sans)',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="3" x2="8" y2="13" />
                <line x1="3" y1="8" x2="13" y2="8" />
              </svg>
              <span>Add project from folder</span>
              {ENABLE_BUILDER && onCreateProject ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onCreateProject(); }}
                  style={{
                    fontSize: 10.5,
                    color: 'var(--text-tertiary)',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                    textDecoration: 'underline',
                  }}
                >
                  or create new
                </button>
              ) : (
                <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                  or connect a GitHub repo
                </span>
              )}
            </div>
          </div>
        )}
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={[
              ...(contextMenu.project.path ? [{
                label: 'Open in folder',
                icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                ),
                onClick: () => {
                  void handleOpenProjectFolder(contextMenu.project);
                },
              }] : []),
              {
                label: 'Remove project',
                danger: true,
                icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                ),
                onClick: () => setConfirmRemove(contextMenu.project),
              },
            ]}
            onClose={() => setContextMenu(null)}
          />
        )}
        {confirmRemove && (
          <ConfirmDialog
            isOpen
            title={`Remove "${confirmRemove.name}"?`}
            message={
              confirmRemove.source && confirmRemove.source !== 'builder' && confirmRemove.source !== 'github'
                ? 'This will stop watching and delete all review history. The folder on disk will not be affected.'
                : 'This will delete the project and all its data.'
            }
            confirmLabel="Remove"
            danger
            onCancel={() => setConfirmRemove(null)}
            onConfirm={async () => {
              const project = confirmRemove;
              setConfirmRemove(null);
              await handleRemoveProject(project);
            }}
          />
        )}
      </div>
      <AllProjectsShortcutBar />
    </div>
  );
}

function AllProjectsShortcutBar() {
  const items = [
    'Enter/Space: open',
    '/: search',
    'j/k or arrows: move',
    '?: shortcuts',
  ];

  return (
    <div
      style={{
        height: 24,
        minHeight: 24,
        background: 'var(--review-panel-header-bg)',
        borderTop: '1px solid var(--review-shell-divider)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 var(--space-3)',
        fontSize: 'var(--text-xs)',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-tertiary)',
        gap: 'var(--space-4)',
        flexShrink: 0,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}

function PendingProjectCard({ path }: { path: string }) {
  const name = path.split(/[\\/]/).filter(Boolean).slice(-1)[0] || 'Opening project';
  return (
    <div
      aria-live="polite"
      style={{
        background: 'var(--bg-surface)',
        border: '1px dashed var(--review-shell-divider)',
        borderRadius: 6,
        padding: 16,
        minHeight: 160,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        fontFamily: 'var(--font-sans)',
        opacity: 0.86,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: 'var(--accent-blue)',
            boxShadow: '0 0 5px var(--accent-blue)',
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
            {name}
          </div>
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
            {path}
          </div>
        </div>
        <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
          Opening
        </span>
      </div>

      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        <div style={{ height: 8, width: '72%', borderRadius: 999, background: 'var(--bg-overlay)' }} />
        <div style={{ height: 8, width: '48%', borderRadius: 999, background: 'var(--bg-overlay)' }} />
      </div>

      <div
        style={{
          marginTop: 'auto',
          paddingTop: 10,
          borderTop: '1px solid var(--review-shell-divider)',
          fontSize: 11,
          color: 'var(--text-tertiary)',
        }}
      >
        Preparing local project…
      </div>
    </div>
  );
}

function MetricTile({
  k,
  v,
  sub,
  warn = false,
}: {
  k: string;
  v: string;
  sub: string;
  warn?: boolean;
}) {
  return (
    <div style={{ background: 'var(--bg-surface)', padding: '14px 18px' }}>
      <div
        style={{
          fontSize: 10.5,
          color: 'var(--text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          fontWeight: 500,
        }}
      >
        {k}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: -0.4,
          marginTop: 4,
          color: warn ? 'var(--sev-high)' : 'var(--text-primary)',
        }}
      >
        {v}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}

export default AllProjectsOverview;
