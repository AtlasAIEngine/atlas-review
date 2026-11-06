/**
 * ProjectHome — Direction C project home (replaces the legacy
 * TrustChangeSetList-on-select flow). See `direction-c.jsx` `C_Projects`
 * (lines 332–383) for the visual spec.
 *
 * Layout inside the existing TrustPipelineShell:
 *   row 1: project toolbar (logo chip + ProjectSwitcher + Search + GitHub + New)
 *   row 2: tab bar (Branches | Pull Requests)
 *   body:  active tab content (BranchesTab / PRsTab)
 *
 * When the user clicks a branch or PR, `onOpenReview` is invoked so the
 * caller (TrustPipelineShell) can hand off to TrustReviewView with the
 * selected item preset.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { branchReviewApi, prReviewApi, projectApi, reviewApi, settingsApi, watcherApi } from '@/services/api';
import githubApi from '@/services/githubApi';
import type { BranchReview, PrReview, Project, ReviewOutcomeScope, ReviewRecommendation } from '@/types';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import {
  AUTO_REVIEW_SETTING_CHANGED_EVENT,
  type AutoReviewSettingChangedDetail,
} from '@/constants/autoReviewEvents';
import { ENABLE_BUILDER } from '@/featureFlags';
import { GITHUB_CONNECTION_CHANGED_EVENT, dispatchGitHubConnectionChanged } from '@/constants/githubEvents';
import toast from '@/lib/toast';
import { subscribeProjectSocket } from '@/services/projectSocket';
import { formatShortcut } from '@/utils/keyboardShortcuts';
import { openExternal } from '@/utils/openExternal';
import { isTauriEnvironment } from '@/utils/tauri';
import { Btn, SevChip } from './review/primitives';
import { ProjectSwitcher, type SwitcherProject } from './review/ProjectSwitcher';
import { CodegraphStatusBadge } from './CodegraphStatusBadge';
import { BranchRow, BranchRowSkeleton, type BranchRowData } from './review/BranchRow';
import { ProjectAnalytics, type ProjectAnalyticsMetrics } from './review/ProjectAnalytics';
import { PRLane } from './review/PRLane';
import { PRCard, PRCardSkeleton, type PRCardData } from './review/PRCard';
import {
  getProjectHomeBranchSortTimeMs,
  pickLatestProjectHomeBranchTimestamp,
  sortProjectHomeBranchRows,
  type SortableBranchRowData,
} from './projectHomeBranchRows';
import {
  buildProjectHomePrLanes,
  selectPrimaryGitHubUserLogin,
  type ProjectHomePrLaneKey,
} from './projectHomePrLanes';
import {
  getRecommendationResolutionFor,
  normalizeRecommendationResolutionMap,
  type RecommendationResolutionMap,
} from './review/reviewPanelUtils';

export type ProjectHomeTab = 'branches' | 'prs';

interface PrSyncAccessDenied {
  owner: string;
  repo: string;
  connectedLogin: string | null;
}

const MAX_BRANCH_ROWS = 4;
const INITIAL_BRANCH_RELOAD_DELAYS_MS = [800, 2200] as const;
const PROJECT_AUTO_REVIEW_SETTING_PREFIX = 'project_auto_review_enabled:';
const GITHUB_APP_INSTALL_POLL_INTERVAL_MS = 3000;
const GITHUB_APP_INSTALL_POLL_TIMEOUT_MS = 120000;

function isPrGithubReconnectError(message: string | null): boolean {
  const text = String(message || '').trim();
  if (!text) return false;
  return /project is not connected to github/i.test(text)
    || /github token has expired/i.test(text)
    || /github credentials could not be decrypted/i.test(text)
    || /cannot access pull requests/i.test(text)
    || /please reconnect/i.test(text);
}

function normalizePrSyncAccessDenied(error: unknown): PrSyncAccessDenied | null {
  const data = (error as { response?: { data?: Record<string, unknown> } })?.response?.data || null;
  if (data?.code !== 'GITHUB_REPO_ACCESS_DENIED') return null;
  const owner = String(data.owner || '').trim();
  const repo = String(data.repo || '').trim();
  if (!owner || !repo) return null;
  const connectedLogin = String(data.connectedLogin || '').trim() || null;
  return { owner, repo, connectedLogin };
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown; message?: unknown } } })?.response?.data || null;
  return String(data?.error || data?.message || (error instanceof Error ? error.message : '') || fallback);
}

function findActiveInstallationForOwner(installations: Awaited<ReturnType<typeof githubApi.getInstallations>>, owner: string) {
  const ownerLower = owner.toLowerCase();
  return installations.find((installation) => (
    installation.accountLogin.toLowerCase() === ownerLower
    && installation.isActive !== false
  )) || null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function parseStoredBoolean(value: string | null | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

interface LocalBranch {
  name: string;
  current: boolean;
  headSha?: string | null;
  lastCommitAt?: string | null;
  aheadCount?: number | null;
  isWorktree?: boolean;
}

let cachedProjects: Project[] | null = null;
const cachedBranchReviewsByProject = new Map<string, BranchReview[]>();
const cachedLocalBranchesByProject = new Map<string, LocalBranch[]>();
const cachedPrReviewsByProject = new Map<string, PrReview[]>();
const cachedPrSyncAtByProject = new Map<string, string | null>();
const cachedOutcomeMapsByProject = new Map<string, Record<string, RecommendationResolutionMap>>();
let cachedConnectedGitHubUserLogins: string[] | null = null;

export interface ProjectHomeOpenReview {
  projectId: string;
  kind: 'branch_review' | 'pr_review' | 'base_branch';
  id?: string;
  branchName?: string;
}

interface ProjectHomeProps {
  projectId: string;
  onOpenReview: (payload: ProjectHomeOpenReview) => void;
  onOpenAllProjects: () => void;
  onSwitchProject: (projectId: string) => void;
  onAddProjectFromFolder?: () => void;
  onCreateProject?: () => void;
  onOpenGlobalSettingsSection?: (section: 'github' | 'cloud') => void;
  activeTab?: ProjectHomeTab;
  onTabChange?: (tab: ProjectHomeTab) => void;
  /** Refresh key — bump to force re-fetch. */
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

function getOutcomeMap(
  outcomeMaps: Record<string, RecommendationResolutionMap>,
  reviewType: ReviewOutcomeScope['reviewType'],
  reviewId: string,
): RecommendationResolutionMap | undefined {
  return outcomeMaps[`${reviewType}:${reviewId}`];
}

function computeRisk(br: BranchReview, outcomes?: RecommendationResolutionMap): BranchRowData['risk'] {
  const { high, med } = countSeverities(br.reviewJson?.recommendations, outcomes);
  if (high > 0) return 'high';
  if (med > 0) return 'med';
  if (br.reviewStatus === 'reviewed' || br.reviewStatus === 'completed') return 'clean';
  return 'low';
}

function isReviewGenerating(status: string | null | undefined): boolean {
  return status === 'queued'
    || status === 'reviewing'
    || status === 'running'
    || status === 'retrying';
}

function isReviewComplete(status: string | null | undefined): boolean {
  return status === 'reviewed' || status === 'completed';
}

function tallyBranchSeverities(
  br: BranchReview,
  outcomes?: RecommendationResolutionMap,
): { high: number; med: number; low: number } {
  return countSeverities(br.reviewJson?.recommendations, outcomes);
}

function tallyPrSeverities(
  pr: PrReview,
  outcomes?: RecommendationResolutionMap,
): { high: number; med: number; low: number } {
  return countSeverities(pr.reviewJson?.recommendations, outcomes);
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

function coveragePercent(br: BranchReview): number {
  // TODO(analytics): derive real coverage — fallback heuristic based on completeness.
  if (isReviewComplete(br.reviewStatus)) return 95;
  if (isReviewGenerating(br.reviewStatus)) return 40;
  return 0;
}

function selectProjectPresence(
  br: BranchReview[] | undefined,
): SwitcherProject['presence'] {
  if (!br || br.length === 0) return 'quiet';
  const anyHigh = br.some((r) => r.reviewRiskLevel === 'high' || r.reviewRiskLevel === 'critical');
  if (anyHigh) return 'risk';
  const anyPending = br.some((r) => isReviewGenerating(r.reviewStatus));
  if (anyPending) return 'pending';
  return 'quiet';
}

function isTrackedBranchReview(br: BranchReview): boolean {
  return br.status === 'active' || br.status === 'stale';
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

function isProjectBaseBranch(branchName: string, projectBaseBranch: string | null | undefined): boolean {
  const name = branchName.trim().toLowerCase();
  const base = String(projectBaseBranch || '').trim().toLowerCase();
  return Boolean(name && base && name === base);
}

function ProjectHome({
  projectId,
  onOpenReview,
  onOpenAllProjects,
  onSwitchProject,
  onAddProjectFromFolder,
  onCreateProject,
  onOpenGlobalSettingsSection,
  activeTab,
  onTabChange,
  refreshKey = 0,
}: ProjectHomeProps) {
  const [uncontrolledTab, setUncontrolledTab] = useState<ProjectHomeTab>('branches');
  const tab = activeTab ?? uncontrolledTab;
  const [projects, setProjects] = useState<Project[]>(() => cachedProjects ?? []);
  const [currentProject, setCurrentProject] = useState<Project | null>(() => (
    cachedProjects?.find((p) => p.id === projectId) || null
  ));
  const [branchReviews, setBranchReviews] = useState<BranchReview[]>(() => (
    cachedBranchReviewsByProject.get(projectId) ?? []
  ));
  const [localBranches, setLocalBranches] = useState<LocalBranch[]>(() => (
    cachedLocalBranchesByProject.get(projectId) ?? []
  ));
  const [prReviews, setPrReviews] = useState<PrReview[]>(() => (
    cachedPrReviewsByProject.get(projectId) ?? []
  ));
  const [visibleBranchLimit, setVisibleBranchLimit] = useState(MAX_BRANCH_ROWS);
  const [selectedBranchRowId, setSelectedBranchRowId] = useState<string | null>(null);
  const [selectedPrCardId, setSelectedPrCardId] = useState<string | null>(null);
  const [prSearchQuery, setPrSearchQuery] = useState('');
  const [isBranchListHovered, setIsBranchListHovered] = useState(false);
  const [reviewOutcomeMaps, setReviewOutcomeMaps] = useState<Record<string, RecommendationResolutionMap>>(() => (
    cachedOutcomeMapsByProject.get(projectId) ?? {}
  ));
  const [connectedGitHubUserLogins, setConnectedGitHubUserLogins] = useState<string[]>(() => (
    cachedConnectedGitHubUserLogins ?? []
  ));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prSyncError, setPrSyncError] = useState<string | null>(null);
  const [prSyncAccessDenied, setPrSyncAccessDenied] = useState<PrSyncAccessDenied | null>(null);
  const [openingGitHubAppAccess, setOpeningGitHubAppAccess] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(() => (
    cachedPrSyncAtByProject.get(projectId) ?? null
  ));
  // Heartbeat that re-renders every 30s so the "last sync Nm ago" label
  // advances over time. Without it, relativeTimeLabel(latestSyncAt) stays
  // frozen at the value computed on the last sync (typically "0m"), even
  // as minutes pass — there are no other state changes in this view that
  // would naturally re-render.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const [prLoading, setPrLoading] = useState(false);
  const [globalAutoReviewEnabled, setGlobalAutoReviewEnabled] = useState(true);
  const [projectAutoReviewEnabled, setProjectAutoReviewEnabled] = useState(false);
  const [autoReviewSettingsLoading, setAutoReviewSettingsLoading] = useState(true);
  const [autoReviewSettingsSaving, setAutoReviewSettingsSaving] = useState(false);
  const projectLoadSeqRef = useRef(0);
  const branchLoadSeqRef = useRef(0);
  const branchRefreshSeqRef = useRef(0);
  const branchOpenSeqRef = useRef(0);
  const branchListRef = useRef<HTMLDivElement | null>(null);
  const prBoardRef = useRef<HTMLDivElement | null>(null);
  const prSearchInputRef = useRef<HTMLInputElement | null>(null);
  const prLoadSeqRef = useRef(0);
  const outcomeLoadSeqRef = useRef(0);
  const prSyncSeqRef = useRef(0);
  const prSyncInFlightRef = useRef(false);
  const githubAppAccessSeqRef = useRef(0);
  const githubAppAccessMountedRef = useRef(true);
  const activeProjectIdRef = useRef(projectId);
  const { user, refresh: refreshCurrentUser } = useCurrentUser();

  useEffect(() => () => {
    githubAppAccessMountedRef.current = false;
    githubAppAccessSeqRef.current += 1;
  }, []);

  useEffect(() => {
    activeProjectIdRef.current = projectId;
    branchOpenSeqRef.current += 1;
    prSyncInFlightRef.current = false;
    githubAppAccessSeqRef.current += 1;
    branchRefreshSeqRef.current += 1;
    setBranchSyncing(false);
    setSyncing(false);
    setOpeningGitHubAppAccess(false);
    setPrLoading(false);
    setSelectedBranchRowId(null);
    setSelectedPrCardId(null);
    setGlobalAutoReviewEnabled(true);
    setProjectAutoReviewEnabled(false);
    setAutoReviewSettingsLoading(true);
    setAutoReviewSettingsSaving(false);
  }, [projectId]);

  const handleTabChange = useCallback((nextTab: ProjectHomeTab) => {
    if (activeTab === undefined) {
      setUncontrolledTab(nextTab);
    }
    onTabChange?.(nextTab);
  }, [activeTab, onTabChange]);

  const projectAutoReviewSettingKey = useMemo(
    () => `${PROJECT_AUTO_REVIEW_SETTING_PREFIX}${projectId}`,
    [projectId],
  );

  const loadAutoReviewSettings = useCallback(async () => {
    setAutoReviewSettingsLoading(true);
    try {
      const [globalRes, projectRes] = await Promise.allSettled([
        settingsApi.get('auto_review_enabled'),
        settingsApi.get(projectAutoReviewSettingKey),
      ]);
      const nextGlobalEnabled = globalRes.status === 'fulfilled'
        ? parseStoredBoolean(globalRes.value.value, true)
        : true;
      const nextProjectEnabled = projectRes.status === 'fulfilled'
        ? parseStoredBoolean(projectRes.value.value, false)
        : false;
      setGlobalAutoReviewEnabled(nextGlobalEnabled);
      setProjectAutoReviewEnabled(nextProjectEnabled);
    } finally {
      setAutoReviewSettingsLoading(false);
    }
  }, [projectAutoReviewSettingKey]);

  // TODO(analytics): switcher severity / status per project is stubbed — we'd
  // need an aggregate endpoint to avoid N+1 branch-review calls across projects.
  const switcherProjects = useMemo<SwitcherProject[]>(() => {
    const safe = Array.isArray(projects) ? projects : [];
    return safe.map((p) => ({
      ...p,
      severity: p.id === projectId ? (() => {
        const tracked = branchReviews.filter(isTrackedBranchReview);
        const totals = tracked.reduce(
          (acc, br) => {
            const t = tallyBranchSeverities(
              br,
              getOutcomeMap(reviewOutcomeMaps, 'branch_review', br.id),
            );
            acc.high += t.high;
            acc.med += t.med;
            return acc;
          },
          { high: 0, med: 0 },
        );
        return totals;
      })() : undefined,
      presence: p.id === projectId ? selectProjectPresence(branchReviews.filter(isTrackedBranchReview)) : 'quiet',
    }));
  }, [projects, projectId, branchReviews, reviewOutcomeMaps]);

  const loadProjects = useCallback(async () => {
    const seq = projectLoadSeqRef.current + 1;
    projectLoadSeqRef.current = seq;
    try {
      const res = await projectApi.list();
      const list = Array.isArray(res.projects) ? res.projects : [];
      if (projectLoadSeqRef.current !== seq) return;
      cachedProjects = list;
      setProjects(list);
      setCurrentProject(list.find((p) => p.id === projectId) || null);
    } catch {
      // keep the previous state rather than wiping the top bar label
    }
  }, [projectId]);

  const loadBranchReviews = useCallback(async () => {
    const seq = branchLoadSeqRef.current + 1;
    branchLoadSeqRef.current = seq;
    try {
      const [reviewRes, branchRes] = await Promise.allSettled([
        branchReviewApi.list(projectId, { refreshCurrent: true }),
        branchReviewApi.listBranches(projectId),
      ]);
      if (branchLoadSeqRef.current !== seq) return;
      if (reviewRes.status === 'fulfilled') {
        const nextBranchReviews = Array.isArray(reviewRes.value.branchReviews) ? reviewRes.value.branchReviews : [];
        cachedBranchReviewsByProject.set(projectId, nextBranchReviews);
        setBranchReviews(nextBranchReviews);
      }
      if (branchRes.status === 'fulfilled') {
        const nextLocalBranches = Array.isArray(branchRes.value.branches) ? branchRes.value.branches : [];
        cachedLocalBranchesByProject.set(projectId, nextLocalBranches);
        setLocalBranches(nextLocalBranches);
      }
      if (reviewRes.status === 'rejected' && branchRes.status === 'rejected') {
        throw reviewRes.reason;
      }
      setLoadError(null);
    } catch (err) {
      if (branchLoadSeqRef.current !== seq) return;
      setLoadError(err instanceof Error ? err.message : 'Failed to load branch reviews');
    }
  }, [projectId]);

  const loadPrReviews = useCallback(async () => {
    const seq = prLoadSeqRef.current + 1;
    const syncSeqAtStart = prSyncSeqRef.current;
    const syncInFlightAtStart = prSyncInFlightRef.current;
    prLoadSeqRef.current = seq;
    setPrLoading(true);
    try {
      const res = await prReviewApi.list(projectId);
      if (prLoadSeqRef.current !== seq) return;
      if (syncInFlightAtStart || prSyncSeqRef.current !== syncSeqAtStart) return;
      const nextPrReviews = Array.isArray(res.prReviews) ? res.prReviews : [];
      cachedPrReviewsByProject.set(projectId, nextPrReviews);
      setPrReviews(nextPrReviews);
      // Seed the last-sync chip from the server-stored timestamp on initial
      // list load so a fresh page load shows the actual time since the last
      // sync (not "0m ago" set by a subsequent client-side sync).
      if (res.lastSyncedAt) {
        cachedPrSyncAtByProject.set(projectId, res.lastSyncedAt);
        setLastSyncAt(res.lastSyncedAt);
      }
    } catch {
      // Preserve cached PRs while the background refresh recovers.
    } finally {
      if (prLoadSeqRef.current === seq) {
        setPrLoading(false);
      }
    }
  }, [projectId]);

  const loadConnectedGitHubUserLogins = useCallback(async () => {
    try {
      const installations = await githubApi.getInstallations({ summary: true });
      const logins = installations
        .filter((installation) => installation.isActive !== false)
        .filter((installation) => String(installation.accountType || '').toLowerCase() === 'user')
        .sort((left, right) => {
          const leftUpdatedAt = new Date(left.updatedAt || 0).getTime();
          const rightUpdatedAt = new Date(right.updatedAt || 0).getTime();
          return (Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : 0)
            - (Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : 0);
        })
        .map((installation) => String(installation.accountLogin || '').trim())
        .filter(Boolean);
      cachedConnectedGitHubUserLogins = logins;
      setConnectedGitHubUserLogins(logins);
    } catch {
      // Keep the previous account list; PR lane grouping can still use the signed-in user.
    }
  }, []);

  const [branchSyncing, setBranchSyncing] = useState(false);
  const refreshBranchReviews = useCallback(async () => {
    const seq = branchLoadSeqRef.current + 1;
    const refreshSeq = branchRefreshSeqRef.current + 1;
    branchLoadSeqRef.current = seq;
    branchRefreshSeqRef.current = refreshSeq;
    setBranchSyncing(true);
    try {
      let syncError: string | null = null;
      try {
        await watcherApi.syncNow(projectId);
      } catch (err) {
        syncError = err instanceof Error ? err.message : 'Failed to sync working tree';
      }
      const [reviewRes, branchRes] = await Promise.allSettled([
        branchReviewApi.list(projectId, { refreshCurrent: true }),
        branchReviewApi.listBranches(projectId),
      ]);
      if (branchLoadSeqRef.current !== seq) return;
      if (reviewRes.status === 'fulfilled') {
        const nextBranchReviews = Array.isArray(reviewRes.value.branchReviews) ? reviewRes.value.branchReviews : [];
        cachedBranchReviewsByProject.set(projectId, nextBranchReviews);
        setBranchReviews(nextBranchReviews);
      }
      if (branchRes.status === 'fulfilled') {
        const nextLocalBranches = Array.isArray(branchRes.value.branches) ? branchRes.value.branches : [];
        cachedLocalBranchesByProject.set(projectId, nextLocalBranches);
        setLocalBranches(nextLocalBranches);
      }
      if (reviewRes.status === 'rejected' && branchRes.status === 'rejected') {
        throw reviewRes.reason;
      }
      setLoadError(syncError);
    } catch (err) {
      if (branchLoadSeqRef.current !== seq) return;
      setLoadError(err instanceof Error ? err.message : 'Failed to refresh branch reviews');
    } finally {
      if (branchRefreshSeqRef.current === refreshSeq) {
        setBranchSyncing(false);
      }
    }
  }, [projectId]);

  const handleProjectAutoReviewToggle = useCallback(async () => {
    if (autoReviewSettingsSaving || autoReviewSettingsLoading || !globalAutoReviewEnabled) return;
    const nextValue = !projectAutoReviewEnabled;
    setProjectAutoReviewEnabled(nextValue);
    setAutoReviewSettingsSaving(true);
    try {
      await settingsApi.set(projectAutoReviewSettingKey, String(nextValue));
      toast.success(nextValue ? 'Auto-review enabled for this project' : 'Auto-review disabled for this project');
      if (nextValue) {
        void refreshBranchReviews();
      }
    } catch {
      setProjectAutoReviewEnabled(!nextValue);
      toast.error('Failed to save auto-review setting');
    } finally {
      setAutoReviewSettingsSaving(false);
    }
  }, [
    autoReviewSettingsLoading,
    autoReviewSettingsSaving,
    globalAutoReviewEnabled,
    projectAutoReviewEnabled,
    projectAutoReviewSettingKey,
    refreshBranchReviews,
  ]);

  const [syncing, setSyncing] = useState(false);
  const syncPrReviews = useCallback(async () => {
    const syncSeq = prSyncSeqRef.current + 1;
    prSyncSeqRef.current = syncSeq;
    prSyncInFlightRef.current = true;
    setSyncing(true);
    setPrSyncError(null);
    setPrSyncAccessDenied(null);
    try {
      const res = await prReviewApi.sync(projectId);
      if (prSyncSeqRef.current !== syncSeq || activeProjectIdRef.current !== projectId) return;
      const nextPrReviews = Array.isArray(res.prReviews) ? res.prReviews : [];
      // Prefer the server-stored sync timestamp so a fresh page load reads
      // the actual last-sync time rather than "0m ago" from a freshly-set
      // client clock.
      const nextSyncAt = res.lastSyncedAt || new Date().toISOString();
      cachedPrReviewsByProject.set(projectId, nextPrReviews);
      cachedPrSyncAtByProject.set(projectId, nextSyncAt);
      setPrReviews(nextPrReviews);
      setLastSyncAt(nextSyncAt);
    } catch (err) {
      if (prSyncSeqRef.current !== syncSeq || activeProjectIdRef.current !== projectId) return;
      setPrSyncAccessDenied(normalizePrSyncAccessDenied(err));
      setPrSyncError(getApiErrorMessage(err, 'Failed to refresh pull requests from GitHub'));
      // Keep the existing list on failure; only the chip resets.
    } finally {
      if (prSyncSeqRef.current === syncSeq && activeProjectIdRef.current === projectId) {
        prSyncInFlightRef.current = false;
        setSyncing(false);
      }
    }
  }, [projectId]);

  const openGitHubAppAccess = useCallback(async () => {
    if (!prSyncAccessDenied?.owner) {
      onOpenGlobalSettingsSection?.('github');
      return;
    }

    const owner = prSyncAccessDenied.owner;
    const accessSeq = githubAppAccessSeqRef.current + 1;
    githubAppAccessSeqRef.current = accessSeq;
    const shouldContinue = () => (
      githubAppAccessMountedRef.current
      && githubAppAccessSeqRef.current === accessSeq
      && activeProjectIdRef.current === projectId
    );
    const browserPopup = !isTauriEnvironment()
      ? window.open('', 'atlas-github-app-install', 'width=900,height=720')
      : null;
    const closePopup = () => {
      if (browserPopup && !browserPopup.closed) {
        browserPopup.close();
      }
    };
    const abortIfStopped = () => {
      if (shouldContinue()) return false;
      closePopup();
      return true;
    };
    setOpeningGitHubAppAccess(true);
    try {
      const orgs = await githubApi.getUserOrgs();
      if (abortIfStopped()) return;
      const targetOrg = orgs.find((org) => String(org.login || '').toLowerCase() === owner.toLowerCase());
      const { installUrl } = await githubApi.getInstallUrl(targetOrg?.id);
      if (abortIfStopped()) return;

      if (browserPopup && !browserPopup.closed) {
        browserPopup.location.href = installUrl;
      } else {
        await openExternal(installUrl);
      }

      const startedAt = Date.now();
      while (Date.now() - startedAt < GITHUB_APP_INSTALL_POLL_TIMEOUT_MS) {
        await wait(GITHUB_APP_INSTALL_POLL_INTERVAL_MS);
        if (abortIfStopped()) return;
        const updated = await githubApi.getInstallations({ reactivateAccount: owner });
        if (abortIfStopped()) return;
        const installation = findActiveInstallationForOwner(updated, owner);
        if (!installation) continue;

        closePopup();
        dispatchGitHubConnectionChanged({
          reason: 'org_installed',
          accountLogin: owner,
          installationId: installation.installationId,
        });
        toast.success(`${owner} access granted`);
        await syncPrReviews();
        return;
      }
      if (abortIfStopped()) return;
      toast.info(`Waiting for ${owner} approval`, {
        description: 'If GitHub opened an approval request, Atlas will pick it up after the organization approves the app.',
      });
    } catch (err) {
      if (abortIfStopped()) return;
      closePopup();
      toast.error(getApiErrorMessage(err, `Failed to open GitHub App access for ${owner}`));
      onOpenGlobalSettingsSection?.('github');
    } finally {
      if (shouldContinue()) {
        setOpeningGitHubAppAccess(false);
      }
    }
  }, [onOpenGlobalSettingsSection, prSyncAccessDenied, syncPrReviews]);

  useEffect(() => {
    const nextProjects = cachedProjects ?? [];
    setProjects(nextProjects);
    setCurrentProject(nextProjects.find((p) => p.id === projectId) || null);
    setBranchReviews(cachedBranchReviewsByProject.get(projectId) ?? []);
    setLocalBranches(cachedLocalBranchesByProject.get(projectId) ?? []);
    setPrReviews(cachedPrReviewsByProject.get(projectId) ?? []);
    setVisibleBranchLimit(MAX_BRANCH_ROWS);
    setReviewOutcomeMaps(cachedOutcomeMapsByProject.get(projectId) ?? {});
    setLastSyncAt(cachedPrSyncAtByProject.get(projectId) ?? null);
    setLoadError(null);
    setPrSyncError(null);
    setPrSyncAccessDenied(null);
  }, [projectId]);

  const reviewOutcomeScopes = useMemo(() => {
    const scopes: Array<{ key: string; reviewType: ReviewOutcomeScope['reviewType']; reviewId: string }> = [];
    const addScope = (reviewType: ReviewOutcomeScope['reviewType'], reviewId: string, recommendations: ReviewRecommendation[] | undefined) => {
      if (!reviewId || !Array.isArray(recommendations) || recommendations.length === 0) return;
      scopes.push({ key: `${reviewType}:${reviewId}`, reviewType, reviewId });
    };
    for (const br of branchReviews.filter(isTrackedBranchReview)) {
      addScope('branch_review', br.id, br.reviewJson?.recommendations);
    }
    for (const pr of prReviews) {
      addScope('pr_review', pr.id, pr.reviewJson?.recommendations);
    }
    return scopes;
  }, [branchReviews, prReviews]);

  const refreshReviewOutcomeScope = useCallback(async (
    reviewType: ReviewOutcomeScope['reviewType'],
    reviewId: string,
  ) => {
    if (!reviewId) return;
    const key = `${reviewType}:${reviewId}`;
    try {
      const response = await reviewApi.getOutcomes(projectId, { reviewType, reviewId });
      const nextMap = normalizeRecommendationResolutionMap(response.byRecommendationKey);
      setReviewOutcomeMaps((prev) => {
        const next = { ...prev, [key]: nextMap };
        cachedOutcomeMapsByProject.set(projectId, next);
        return next;
      });
    } catch {
      // Keep the current counts; outcome hydration is best-effort on Project Home.
    }
  }, [projectId]);

  const mergeBranchReviewUpdate = useCallback((branchReview: BranchReview) => {
    if (!branchReview?.id) return;
    setBranchReviews((prev) => {
      const current = Array.isArray(prev) ? prev : [];
      let found = false;
      const next = current.map((existing) => {
        if (existing.id !== branchReview.id) return existing;
        found = true;
        return { ...existing, ...branchReview };
      });
      if (!found) {
        next.push(branchReview);
      }
      cachedBranchReviewsByProject.set(projectId, next);
      return next;
    });
  }, [projectId]);

  useEffect(() => {
    if (reviewOutcomeScopes.length === 0) return;
    const seq = outcomeLoadSeqRef.current + 1;
    outcomeLoadSeqRef.current = seq;
    const loadOutcomes = async () => {
      const results = await Promise.allSettled(
        reviewOutcomeScopes.map(async (scope) => {
          const response = await reviewApi.getOutcomes(projectId, {
            reviewType: scope.reviewType,
            reviewId: scope.reviewId,
          });
          return {
            key: scope.key,
            outcomes: normalizeRecommendationResolutionMap(response.byRecommendationKey),
          };
        }),
      );
      if (outcomeLoadSeqRef.current !== seq) return;
      setReviewOutcomeMaps((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          next[result.value.key] = result.value.outcomes;
          changed = true;
        }
        if (!changed) return prev;
        cachedOutcomeMapsByProject.set(projectId, next);
        return next;
      });
    };
    void loadOutcomes();
  }, [projectId, reviewOutcomeScopes]);

  useEffect(() => {
    return subscribeProjectSocket(projectId, {
      'branch-review-update': (payload?: {
        projectId?: string;
        branchReview?: BranchReview;
      }) => {
        if (!payload?.branchReview) return;
        if (payload.projectId && payload.projectId !== projectId) return;
        mergeBranchReviewUpdate(payload.branchReview);
      },
      'review-outcomes-updated': (payload?: {
        projectId?: string;
        reviewType?: string;
        reviewId?: string;
      }) => {
        if (!payload || payload.projectId !== projectId) return;
        const reviewType = String(payload.reviewType || '').trim().toLowerCase() as ReviewOutcomeScope['reviewType'];
        const reviewId = String(payload.reviewId || '').trim();
        if (
          reviewType !== 'branch_review'
          && reviewType !== 'pr_review'
          && reviewType !== 'workspace_review'
        ) return;
        void refreshReviewOutcomeScope(reviewType, reviewId);
      },
    });
  }, [mergeBranchReviewUpdate, projectId, refreshReviewOutcomeScope]);

  useEffect(() => { void loadProjects(); }, [loadProjects, refreshKey]);
  useEffect(() => { void loadBranchReviews(); }, [loadBranchReviews, refreshKey]);
  useEffect(() => { void loadPrReviews(); }, [loadPrReviews, refreshKey]);
  useEffect(() => { void loadConnectedGitHubUserLogins(); }, [loadConnectedGitHubUserLogins, refreshKey]);
  useEffect(() => { void loadAutoReviewSettings(); }, [loadAutoReviewSettings, refreshKey]);
  useEffect(() => {
    const handleAutoReviewChanged = (event: Event) => {
      const detail = (event as CustomEvent<AutoReviewSettingChangedDetail>).detail;
      if (typeof detail?.enabled !== 'boolean') return;
      setGlobalAutoReviewEnabled(detail.enabled);
    };
    window.addEventListener(AUTO_REVIEW_SETTING_CHANGED_EVENT, handleAutoReviewChanged);
    return () => window.removeEventListener(AUTO_REVIEW_SETTING_CHANGED_EVENT, handleAutoReviewChanged);
  }, []);
  // Auto-sync on first ProjectHome render so newly added projects discover
  // the current local branch and freshly-opened PRs without a manual refresh.
  // Skips on subsequent renders triggered by refreshKey alone — those already
  // re-list whatever's local.
  const initialSyncProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialSyncProjectRef.current === projectId) return;
    initialSyncProjectRef.current = projectId;
    let cancelled = false;
    void (async () => {
      await refreshBranchReviews();
      for (const delayMs of INITIAL_BRANCH_RELOAD_DELAYS_MS) {
        await wait(delayMs);
        if (cancelled || activeProjectIdRef.current !== projectId) return;
        await loadBranchReviews();
      }
    })();
    void syncPrReviews();
    return () => {
      cancelled = true;
    };
  }, [loadBranchReviews, projectId, refreshBranchReviews, syncPrReviews]);

  useEffect(() => {
    const handleGitHubConnectionChanged = () => {
      setPrSyncError(null);
      void refreshCurrentUser();
      void loadConnectedGitHubUserLogins();
      void syncPrReviews();
    };

    window.addEventListener(GITHUB_CONNECTION_CHANGED_EVENT, handleGitHubConnectionChanged);
    return () => {
      window.removeEventListener(GITHUB_CONNECTION_CHANGED_EVENT, handleGitHubConnectionChanged);
    };
  }, [loadConnectedGitHubUserLogins, refreshCurrentUser, syncPrReviews]);

  const allBranchRows = useMemo<BranchRowData[]>(() => {
    const safe = Array.isArray(branchReviews) ? branchReviews : [];
    const normalizedLocalBranches = (Array.isArray(localBranches) ? localBranches : [])
      .map((branch) => ({
        name: String(branch?.name || '').trim(),
        current: Boolean(branch?.current),
        isWorktree: Boolean(branch?.isWorktree),
        lastCommitAt: branch?.lastCommitAt || null,
        aheadCount: typeof branch?.aheadCount === 'number' ? branch.aheadCount : null,
      }));
    const localBranchByName = new Map(
      normalizedLocalBranches
        .filter((branch) => branch.name)
        .map((branch) => [branch.name, branch]),
    );
    const trackedRows: SortableBranchRowData[] = safe
      .filter(isTrackedBranchReview)
      .map((br) => {
        const isBaseBranchRow = isProjectBaseBranch(br.branchName, currentProject?.baseBranchDisplay)
          || isProjectBaseBranch(br.branchName, br.baseBranch);
        const localBranch = localBranchByName.get(br.branchName);
        const activityAt = pickLatestProjectHomeBranchTimestamp(
          localBranch?.lastCommitAt,
          br.lastCommitAt,
          br.updatedAt,
        );
        const outcomes = getOutcomeMap(reviewOutcomeMaps, 'branch_review', br.id);
        const sev = tallyBranchSeverities(br, outcomes);
        const generating = !isBaseBranchRow && isReviewGenerating(br.reviewStatus);
        return {
          id: br.id,
          name: br.branchName,
          base: br.baseBranch,
          high: isBaseBranchRow ? 0 : sev.high,
          med: isBaseBranchRow ? 0 : sev.med,
          low: isBaseBranchRow ? 0 : sev.low,
          coverage: isBaseBranchRow ? 0 : coveragePercent(br),
          additions: isBaseBranchRow ? 0 : br.totalAdditions,
          deletions: isBaseBranchRow ? 0 : br.totalDeletions,
          changesLabel: isBaseBranchRow ? 'Not reviewable' : undefined,
          updatedLabel: relativeTimeLabel(activityAt),
          risk: isBaseBranchRow ? 'low' : computeRisk(br, outcomes),
          active: br.isCurrent,
          isWorktree: Boolean(br.isWorktree),
          generating,
          reviewId: isBaseBranchRow ? undefined : br.id,
          nonReviewableBranchName: isBaseBranchRow ? br.branchName : undefined,
          statusLabel: isBaseBranchRow ? 'Base branch' : undefined,
          statusColor: isBaseBranchRow ? 'var(--text-tertiary)' : undefined,
          sortTimeMs: getProjectHomeBranchSortTimeMs(activityAt),
        };
      });
    const trackedNames = new Set(trackedRows.map((row) => row.name));
    const localRows = normalizedLocalBranches
      .filter((branch) => (
        branch.name
        && (
          isProjectBaseBranch(branch.name, currentProject?.baseBranchDisplay)
          || branch.current
          || branch.isWorktree
          || (branch.aheadCount != null && branch.aheadCount > 0)
        )
        && !trackedNames.has(branch.name)
        && (
          isProjectBaseBranch(branch.name, currentProject?.baseBranchDisplay)
          || !isBaseLikeBranch(branch.name, currentProject?.baseBranchDisplay)
        )
      ))
      .map((branch): SortableBranchRowData => {
        const isBaseBranchRow = isProjectBaseBranch(branch.name, currentProject?.baseBranchDisplay);
        return {
          id: `local:${branch.name}`,
          name: branch.name,
          base: currentProject?.baseBranchDisplay || 'base',
          high: 0,
          med: 0,
          low: 0,
          coverage: 0,
          additions: 0,
          deletions: 0,
          changesLabel: isBaseBranchRow
            ? 'Not reviewable'
            : branch.aheadCount != null && branch.aheadCount > 0
              ? `${branch.aheadCount} ${branch.aheadCount === 1 ? 'commit' : 'commits'}`
              : undefined,
          updatedLabel: relativeTimeLabel(branch.lastCommitAt),
          risk: 'low' as const,
          active: branch.current,
          isWorktree: branch.isWorktree,
          nonReviewableBranchName: isBaseBranchRow ? branch.name : undefined,
          statusLabel: isBaseBranchRow
            ? 'Base branch'
            : branch.current
              ? 'Current branch'
              : 'Not reviewed',
          statusColor: 'var(--text-tertiary)',
          sortTimeMs: getProjectHomeBranchSortTimeMs(branch.lastCommitAt),
        };
      });
    return sortProjectHomeBranchRows([...trackedRows, ...localRows]);
  }, [branchReviews, currentProject?.baseBranchDisplay, localBranches, reviewOutcomeMaps]);

  const visibleBranchRows = useMemo(
    () => allBranchRows.slice(0, visibleBranchLimit),
    [allBranchRows, visibleBranchLimit],
  );
  const hiddenBranchCount = Math.max(0, allBranchRows.length - visibleBranchRows.length);
  const canCollapseBranches = allBranchRows.length > MAX_BRANCH_ROWS && hiddenBranchCount === 0;
  const selectedBranchRow = useMemo(() => {
    if (selectedBranchRowId) {
      const row = allBranchRows.find((candidate) => candidate.id === selectedBranchRowId);
      if (row) return row;
    }
    return allBranchRows.find((row) => row.active) || visibleBranchRows[0] || allBranchRows[0] || null;
  }, [allBranchRows, selectedBranchRowId, visibleBranchRows]);

  useEffect(() => {
    if (!selectedBranchRowId) return;
    if (allBranchRows.some((row) => row.id === selectedBranchRowId)) return;
    setSelectedBranchRowId(null);
  }, [allBranchRows, selectedBranchRowId]);

  const focusBranchRow = useCallback((rowId: string) => {
    const focus = () => {
      const root = branchListRef.current;
      const el = root?.querySelector<HTMLElement>(`[data-branch-row-id="${CSS.escape(rowId)}"]`);
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

  const navigateBranchRows = useCallback((fromRow: BranchRowData | null, delta: number) => {
    if (allBranchRows.length === 0) return;
    const fromId = fromRow?.id || selectedBranchRow?.id || allBranchRows[0]?.id;
    let currentIndex = allBranchRows.findIndex((row) => row.id === fromId);
    if (currentIndex < 0) currentIndex = delta > 0 ? -1 : allBranchRows.length;
    const nextIndex = Math.max(0, Math.min(allBranchRows.length - 1, currentIndex + delta));
    const nextRow = allBranchRows[nextIndex];
    if (!nextRow) return;
    setSelectedBranchRowId(nextRow.id);
    if (nextIndex >= visibleBranchLimit) {
      setVisibleBranchLimit(nextIndex + 1);
    }
    focusBranchRow(nextRow.id);
  }, [allBranchRows, focusBranchRow, selectedBranchRow, visibleBranchLimit]);

  const getActiveBranchRowFromElement = useCallback((activeElement: HTMLElement | null): BranchRowData | null => {
    const activeRowId = activeElement
      ?.closest<HTMLElement>('[data-branch-row-id]')
      ?.getAttribute('data-branch-row-id');
    if (!activeRowId) return null;
    return allBranchRows.find((row) => row.id === activeRowId) || null;
  }, [allBranchRows]);

  const openBranchRow = useCallback(async (row: BranchRowData) => {
    const openSeq = branchOpenSeqRef.current + 1;
    branchOpenSeqRef.current = openSeq;
    const isCurrentOpen = () => activeProjectIdRef.current === projectId && branchOpenSeqRef.current === openSeq;

    if (row.nonReviewableBranchName) {
      setBranchSyncing(false);
      onOpenReview({ projectId, kind: 'base_branch', branchName: row.nonReviewableBranchName });
      return;
    }

    if (row.reviewId) {
      setBranchSyncing(false);
      onOpenReview({ projectId, kind: 'branch_review', id: row.reviewId });
      return;
    }

    setBranchSyncing(true);
    try {
      const res = await branchReviewApi.ensureForBranch(projectId, row.name);
      if (!isCurrentOpen()) return;
      const ensured = res.branchReview;
      const nextReviews = [
        ensured,
        ...branchReviews.filter((review) => review.id !== ensured.id),
      ];
      cachedBranchReviewsByProject.set(projectId, nextReviews);
      setBranchReviews(nextReviews);
      onOpenReview({ projectId, kind: 'branch_review', id: ensured.id });
    } catch (err: unknown) {
      const responseMessage = typeof err === 'object' && err && 'response' in err
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : null;
      toast.error(responseMessage || (err instanceof Error ? err.message : 'Failed to open branch review'));
    } finally {
      if (isCurrentOpen()) {
        setBranchSyncing(false);
      }
    }
  }, [branchReviews, onOpenReview, projectId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.altKey) return;
      const isRefreshShortcut = event.key.toLowerCase() === 'r' && (event.metaKey || event.ctrlKey) && !event.shiftKey;
      const isPlainNavigation = !event.metaKey && !event.ctrlKey && !event.shiftKey;
      if (!isRefreshShortcut && (!isPlainNavigation || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Escape'))) return;

      const activeElement = document.activeElement as HTMLElement | null;
      const tag = (activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (activeElement?.isContentEditable) return;

      if (isRefreshShortcut) {
        event.preventDefault();
        if (tab === 'branches') {
          void refreshBranchReviews();
        } else {
          void syncPrReviews();
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenAllProjects();
        return;
      }

      const tabs: ProjectHomeTab[] = ['branches', 'prs'];
      const currentIndex = tabs.indexOf(tab);
      if (currentIndex < 0) return;

      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
      handleTabChange(tabs[nextIndex]);
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleTabChange, onOpenAllProjects, refreshBranchReviews, syncPrReviews, tab]);

  useEffect(() => {
    if (tab !== 'branches') return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const isNavigateKey = event.key === 'j'
        || event.key === 'J'
        || event.key === 'k'
        || event.key === 'K'
        || event.key === 'ArrowUp'
        || event.key === 'ArrowDown';
      const isOpenKey = event.key === 'Enter' || event.key === ' ';
      if (!isNavigateKey && !isOpenKey) return;

      const activeElement = document.activeElement as HTMLElement | null;
      const tag = (activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (activeElement?.isContentEditable) return;

      const activeTag = (activeElement?.tagName || '').toLowerCase();
      const pageHasAmbientFocus = !activeElement || activeElement === document.body || activeElement === document.documentElement || activeTag === 'body';
      const activeInsideBranchList = branchListRef.current?.contains(activeElement) || isBranchListHovered || pageHasAmbientFocus;
      if (!activeInsideBranchList) return;

      const activeRow = getActiveBranchRowFromElement(activeElement);
      if (isOpenKey && tag === 'button' && !activeRow) return;
      event.preventDefault();
      if (isOpenKey) {
        const rowToOpen = activeRow || selectedBranchRow;
        if (!rowToOpen) return;
        setSelectedBranchRowId(rowToOpen.id);
        void openBranchRow(rowToOpen);
        return;
      }
      navigateBranchRows(activeRow, event.key === 'ArrowUp' || event.key.toLowerCase() === 'j' ? -1 : 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [getActiveBranchRowFromElement, isBranchListHovered, navigateBranchRows, openBranchRow, selectedBranchRow, tab]);

  const needsAttention = useMemo(
    () => allBranchRows.filter((r) => r.risk === 'high' || r.risk === 'med').length,
    [allBranchRows],
  );

  // TODO(sync-meta): surface a real project-level sync timestamp from the
  // backend. Fallback: explicit manual-sync timestamp wins, otherwise the
  // latest updatedAt across branchReviews + prReviews.
  const latestSyncAt = useMemo<string | null>(() => {
    if (lastSyncAt) return lastSyncAt;
    const all: string[] = [];
    for (const br of branchReviews) if (br.updatedAt) all.push(br.updatedAt);
    for (const pr of prReviews) if (pr.updatedAt) all.push(pr.updatedAt);
    if (all.length === 0) return null;
    return all.reduce((latest, iso) => (iso > latest ? iso : latest), all[0]);
  }, [branchReviews, prReviews, lastSyncAt]);

  const syncLabel = syncing
    ? 'Syncing…'
    : latestSyncAt
      ? `last sync ${relativeTimeLabel(latestSyncAt)} ago`
      : 'last sync just now';
  const showPrGithubOverlay = isPrGithubReconnectError(prSyncError);
  const showPrSyncInlineError = Boolean(prSyncError && !showPrGithubOverlay);
  const prAccessRepoLabel = prSyncAccessDenied
    ? `${prSyncAccessDenied.owner}/${prSyncAccessDenied.repo}`
    : 'this repository';
  const prGithubOverlayTitle = prSyncAccessDenied
    ? 'GitHub App access required'
    : 'Connect GitHub to refresh PRs';
  const prGithubOverlayMessage = prSyncAccessDenied
    ? `Atlas can see your GitHub sign-in, but the Atlas GitHub App needs access to ${prAccessRepoLabel} before it can refresh PRs.`
    : 'Atlas is showing previously synced pull requests. Reconnect this project to GitHub to fetch the latest open PRs.';
  const prGithubPrimaryActionLabel = prSyncAccessDenied?.owner
    ? `Grant access to ${prSyncAccessDenied.owner}`
    : 'Connect GitHub';

  const analyticsMetrics = useMemo<ProjectAnalyticsMetrics>(() => {
    // TODO(analytics): most of these are derived client-side; a real analytics
    // endpoint should replace this so metrics span full history (not just
    // currently-loaded branch reviews).
    const totalFindings = allBranchRows.reduce((a, r) => a + r.high + r.med + r.low, 0)
      + prReviews.reduce((a, pr) => {
        const t = tallyPrSeverities(pr, getOutcomeMap(reviewOutcomeMaps, 'pr_review', pr.id));
        return a + t.high + t.med + t.low;
      }, 0);
    const reviews = branchReviews.length + prReviews.length;
    const branchesWithFindings = allBranchRows.filter((r) => r.high + r.med + r.low > 0).length;
    return {
      reviews,
      branchReviews: branchReviews.length,
      prReviews: prReviews.length,
      findings: totalFindings,
      avgFindingsPerReview: reviews > 0 ? totalFindings / reviews : 0,
      addressedCount: 0, // TODO(analytics): needs outcome aggregation
      addressedPct: 0, // TODO(analytics): needs outcome aggregation
      dismissedCount: 0, // TODO(analytics): needs outcome aggregation
      pendingCount: totalFindings,
      pendingAcrossBranches: branchesWithFindings,
    };
  }, [allBranchRows, branchReviews, prReviews, reviewOutcomeMaps]);

  const prCards = useMemo<PRCardData[]>(() => {
    const safe = Array.isArray(prReviews) ? prReviews : [];
    return safe.map((pr) => {
      const sev = tallyPrSeverities(pr, getOutcomeMap(reviewOutcomeMaps, 'pr_review', pr.id));
      const isGenerating = isReviewGenerating(pr.reviewStatus);
      const clean = !isGenerating && isReviewComplete(pr.reviewStatus)
        && sev.high === 0 && sev.med === 0 && sev.low === 0;
      const status: 'open' | 'draft' | 'closed' | 'merged' =
        pr.state === 'merged' ? 'merged'
        : pr.state === 'closed' ? 'closed'
        : pr.state === 'draft' ? 'draft'
        : 'open';
      return {
        id: pr.id,
        repo: pr.projectId, // fallback — the repo label is owned by the PR card row; we use project name for consistency
        repoLabel: currentProject?.name || '',
        number: pr.githubPrNumber,
        title: pr.title,
        author: pr.authorLogin,
        authorAvatarUrl: pr.authorAvatarUrl ?? null,
        additions: pr.totalAdditions,
        deletions: pr.totalDeletions,
        relativeTime: relativeTimeLabel(pr.githubUpdatedAt || pr.updatedAt),
        commentCount: Math.max(
          0,
          Math.trunc(Number(pr.githubCommentCount || 0) + Number(pr.githubReviewCommentCount || 0))
        ),
        githubReviewDecision: pr.githubReviewDecision,
        githubLatestReviewState: pr.githubLatestReviewState,
        githubReviewStateCounts: pr.githubReviewStateCounts,
        high: sev.high,
        med: sev.med,
        low: sev.low,
        status,
        isSelfAuthored: pr.isSelfAuthored,
        requestedReviewers: pr.requestedReviewers,
        generating: isGenerating,
        clean,
      };
    });
  }, [prReviews, currentProject, reviewOutcomeMaps]);

  const primaryGitHubUserLogin = useMemo(
    () => selectPrimaryGitHubUserLogin(connectedGitHubUserLogins, user?.github_login),
    [connectedGitHubUserLogins, user?.github_login],
  );
  const prSearchTokens = useMemo(() => {
    return prSearchQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }, [prSearchQuery]);
  const matchesPrSearch = useCallback((pr: PRCardData) => {
    if (prSearchTokens.length === 0) return true;
    const haystack = [
      pr.number != null ? `#${pr.number}` : '',
      pr.number != null ? String(pr.number) : '',
      pr.title || '',
      pr.author || '',
      pr.repoLabel || '',
      pr.status || '',
      Array.isArray(pr.requestedReviewers) ? pr.requestedReviewers.join(' ') : '',
    ].join(' ').toLowerCase();
    return prSearchTokens.every((token) => haystack.includes(token));
  }, [prSearchTokens]);
  const prLanes = useMemo(
    () => buildProjectHomePrLanes({
      prCards,
      primaryGitHubUserLogin,
      matchesPrSearch,
    }),
    [prCards, primaryGitHubUserLogin, matchesPrSearch],
  );
  const prSearchActive = prSearchTokens.length > 0;
  const prSearchTotalMatches = prLanes.ready.length + prLanes.yours.length + prLanes.others.length + prLanes.completed.length;
  const lane = useCallback((key: ProjectHomePrLaneKey) => prLanes[key], [prLanes]);
  const showPrLoadingCards = prCards.length === 0 && (prLoading || syncing) && !showPrGithubOverlay;
  const showBranchLoadingRows = allBranchRows.length === 0 && branchSyncing && !loadError;
  const selectedPrCard = useMemo(() => {
    if (selectedPrCardId) {
      const card = prCards.find((candidate) => candidate.id === selectedPrCardId);
      if (card) return card;
    }
    return prLanes.ready[0] || prLanes.yours[0] || prLanes.others[0] || prLanes.completed[0] || null;
  }, [prCards, prLanes, selectedPrCardId]);

  useEffect(() => {
    if (!selectedPrCardId) return;
    if (prCards.some((pr) => pr.id === selectedPrCardId)) return;
    setSelectedPrCardId(null);
  }, [prCards, selectedPrCardId]);

  const getPrCardLaneKey = useCallback((prId: string | null | undefined): ProjectHomePrLaneKey | null => {
    if (!prId) return null;
    const laneKeys: ProjectHomePrLaneKey[] = ['ready', 'yours', 'others', 'completed'];
    return laneKeys.find((key) => prLanes[key].some((pr) => pr.id === prId)) || null;
  }, [prLanes]);

  const focusPrCard = useCallback((prId: string) => {
    const focus = () => {
      const root = prBoardRef.current;
      const el = root?.querySelector<HTMLElement>(`[data-pr-card-id="${CSS.escape(prId)}"]`);
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

  const navigatePrCards = useCallback((fromPr: PRCardData | null, delta: number) => {
    const fromId = fromPr?.id || selectedPrCard?.id;
    const laneKey = getPrCardLaneKey(fromId);
    if (!laneKey) return;
    const cards = prLanes[laneKey];
    if (cards.length === 0) return;
    let currentIndex = cards.findIndex((pr) => pr.id === fromId);
    if (currentIndex < 0) currentIndex = delta > 0 ? -1 : cards.length;
    const nextIndex = Math.max(0, Math.min(cards.length - 1, currentIndex + delta));
    const nextPr = cards[nextIndex];
    if (!nextPr) return;
    setSelectedPrCardId(nextPr.id);
    focusPrCard(nextPr.id);
  }, [focusPrCard, getPrCardLaneKey, prLanes, selectedPrCard]);

  const getActivePrCardFromElement = useCallback((activeElement: HTMLElement | null): PRCardData | null => {
    const activePrId = activeElement
      ?.closest<HTMLElement>('[data-pr-card-id]')
      ?.getAttribute('data-pr-card-id');
    if (!activePrId) return null;
    return prCards.find((pr) => pr.id === activePrId) || null;
  }, [prCards]);

  useEffect(() => {
    if (tab !== 'prs') return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== '/') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const activeElement = document.activeElement as HTMLElement | null;
      const activeTag = (activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') return;
      if (activeElement?.isContentEditable) return;

      const input = prSearchInputRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tab]);

  useEffect(() => {
    if (tab !== 'prs') return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const isNavigateKey = event.key === 'j'
        || event.key === 'J'
        || event.key === 'k'
        || event.key === 'K'
        || event.key === 'ArrowUp'
        || event.key === 'ArrowDown';
      const isOpenKey = event.key === 'Enter' || event.key === ' ';
      if (!isNavigateKey && !isOpenKey) return;

      const activeElement = document.activeElement as HTMLElement | null;
      const tag = (activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (activeElement?.isContentEditable) return;

      const activeTag = (activeElement?.tagName || '').toLowerCase();
      const pageHasAmbientFocus = !activeElement || activeElement === document.body || activeElement === document.documentElement || activeTag === 'body';
      const activeInsidePrBoard = prBoardRef.current?.contains(activeElement) || pageHasAmbientFocus;
      if (!activeInsidePrBoard) return;

      const activePr = getActivePrCardFromElement(activeElement);
      if (isOpenKey && tag === 'button' && !activePr) return;
      event.preventDefault();
      if (isOpenKey) {
        const prToOpen = activePr || selectedPrCard;
        if (!prToOpen) return;
        setSelectedPrCardId(prToOpen.id);
        onOpenReview({ projectId, kind: 'pr_review', id: prToOpen.id });
        return;
      }
      navigatePrCards(activePr, event.key === 'ArrowUp' || event.key.toLowerCase() === 'j' ? -1 : 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [getActivePrCardFromElement, navigatePrCards, onOpenReview, projectId, selectedPrCard, tab]);

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
      {/* Row 1 — project toolbar: switcher + tabs + last sync (+ New) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          borderBottom: '1px solid var(--review-shell-divider)',
          gap: 10,
          flexShrink: 0,
          background: 'var(--review-panel-bg)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <ProjectSwitcher
          currentProject={currentProject}
          projects={switcherProjects}
          onPick={(p) => onSwitchProject(p.id)}
          onAllProjects={onOpenAllProjects}
          onAddFromFolder={onAddProjectFromFolder}
        />
        <div style={{ width: 8 }} />
        {([
          { k: 'branches', label: 'Branches', count: allBranchRows.length },
          { k: 'prs', label: 'Pull Requests', count: prCards.filter((pr) => (pr.status !== 'closed' && pr.status !== 'merged')).length },
        ] as const).map((t) => {
          const on = tab === t.k;
          return (
            <button
              key={t.k}
              type="button"
              onClick={() => handleTabChange(t.k)}
              style={{
                padding: '12px 14px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 12.5,
                fontWeight: on ? 600 : 500,
                color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
                cursor: 'pointer',
                marginBottom: -1,
                background: 'transparent',
                border: '2px solid transparent',
                borderTopWidth: 0,
                borderLeftWidth: 0,
                borderRightWidth: 0,
                borderBottomColor: on ? 'var(--accent-blue)' : 'transparent',
                borderRadius: 0,
                fontFamily: 'var(--font-sans)',
              }}
            >
              {t.label}
              <span
                style={{
                  fontSize: 10.5,
                  color: 'var(--text-tertiary)',
                  fontVariantNumeric: 'tabular-nums',
                  padding: '1px 6px',
                  background: on ? 'var(--bg-surface-raised)' : 'var(--bg-surface)',
                  borderRadius: 8,
                }}
              >
                {t.count}
              </span>
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        {/* Top-bar sync chip removed: it appeared on both Branches and PR
            tabs even though it only synced PRs, and the PR list section
            already has its own dedicated Sync button + last-sync chip. */}
        {currentProject?.id && (
          <CodegraphStatusBadge projectId={currentProject.id} />
        )}
        {ENABLE_BUILDER && onCreateProject && (
          <Btn variant="primary" size="sm" onClick={onCreateProject}>
            +
            New
          </Btn>
        )}
      </div>

      {/* Body */}
      {tab === 'branches' ? (
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 28px 28px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: -0.2, color: 'var(--text-primary)' }}>
                Branches
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {allBranchRows.length} branches
                {needsAttention > 0 ? ` · ${needsAttention} need attention` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                onClick={() => { void handleProjectAutoReviewToggle(); }}
                disabled={autoReviewSettingsLoading || autoReviewSettingsSaving || !globalAutoReviewEnabled}
                title={
                  !globalAutoReviewEnabled
                    ? 'Global auto-review is disabled in Review Settings'
                    : projectAutoReviewEnabled
                      ? 'Disable automatic branch reviews for this project'
                      : 'Enable automatic branch reviews for this project'
                }
                aria-pressed={projectAutoReviewEnabled && globalAutoReviewEnabled}
                style={{
                  height: 26,
                  padding: '0 9px',
                  borderRadius: 5,
                  border: '1px solid var(--border-default)',
                  background: projectAutoReviewEnabled && globalAutoReviewEnabled
                    ? 'var(--review-segment-active-bg)'
                    : 'transparent',
                  color: projectAutoReviewEnabled && globalAutoReviewEnabled
                    ? 'var(--text-primary)'
                    : 'var(--text-secondary)',
                  fontFamily: 'var(--font-ui)',
                  fontSize: 11.5,
                  fontWeight: 500,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  cursor: (autoReviewSettingsLoading || autoReviewSettingsSaving || !globalAutoReviewEnabled)
                    ? 'not-allowed'
                    : 'pointer',
                  opacity: (autoReviewSettingsLoading || autoReviewSettingsSaving || !globalAutoReviewEnabled)
                    ? 0.55
                    : 1,
                  whiteSpace: 'nowrap',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 22,
                    height: 12,
                    borderRadius: 999,
                    padding: 1,
                    background: projectAutoReviewEnabled && globalAutoReviewEnabled
                      ? 'var(--accent-blue)'
                      : 'var(--bg-surface-raised)',
                    border: '1px solid var(--review-shell-divider)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: projectAutoReviewEnabled && globalAutoReviewEnabled ? 'flex-end' : 'flex-start',
                    transition: 'background var(--transition-fast)',
                    boxSizing: 'border-box',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: projectAutoReviewEnabled && globalAutoReviewEnabled
                        ? 'var(--review-primary-action-fg)'
                        : 'var(--text-tertiary)',
                      display: 'block',
                    }}
                  />
                </span>
                Auto review
              </button>
              <Btn
                variant="ghost"
                size="sm"
                onClick={() => { void refreshBranchReviews(); }}
                disabled={branchSyncing}
                title="Reconcile branch list with the working tree (find new branches, mark merged)."
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ animation: branchSyncing ? 'atlas-spin 1s linear infinite' : undefined }}
                >
                  <path d="M14 8a6 6 0 1 1-1.76-4.24" />
                  <polyline points="14 3 14 7 10 7" />
                </svg>
                {branchSyncing ? 'Refreshing…' : 'Refresh'}
              </Btn>
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
                marginBottom: 10,
              }}
            >
              {loadError}
            </div>
          )}
          {allBranchRows.length === 0 && !loadError && !showBranchLoadingRows ? (
            <div
              style={{
                border: '1px dashed var(--review-shell-divider)',
                borderRadius: 6,
                padding: '32px 24px',
                textAlign: 'center',
                color: 'var(--text-tertiary)',
                fontSize: 12.5,
                background: 'var(--bg-surface)',
              }}
            >
              No active branch reviews yet. Push a topic branch to see it here.
            </div>
          ) : (
            <div
              ref={branchListRef}
              onMouseEnter={() => setIsBranchListHovered(true)}
              onMouseLeave={() => setIsBranchListHovered(false)}
              style={{
                border: '1px solid var(--review-shell-divider)',
                borderRadius: 5,
                overflow: 'hidden',
                background: 'var(--bg-surface)',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '20px 1fr 150px 130px 100px 90px',
                  gap: 14,
                  padding: '7px 14px',
                  fontSize: 10,
                  color: 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  fontWeight: 600,
                  borderBottom: '1px solid var(--review-shell-divider)',
                  background: 'var(--review-shell-bg)',
                }}
              >
                <span />
                <span>Branch</span>
                <span>Findings</span>
                <span>Coverage</span>
                <span>Changes</span>
                <span>Updated</span>
              </div>
              {showBranchLoadingRows ? (
                <>
                  <BranchRowSkeleton withTopDivider={false} delayMs={0} />
                  <BranchRowSkeleton delayMs={120} />
                </>
              ) : (
                visibleBranchRows.map((row, i) => (
                  <BranchRow
                    key={row.id}
                    row={row}
                    withTopDivider={i > 0}
                    selected={selectedBranchRowId === row.id}
                    onFocusRow={(r) => setSelectedBranchRowId(r.id)}
                    onNavigate={navigateBranchRows}
                    onClick={(r) => {
                      setSelectedBranchRowId(r.id);
                      void openBranchRow(r);
                    }}
                  />
                ))
              )}
              {(hiddenBranchCount > 0 || canCollapseBranches) && (
                <button
                  type="button"
                  onClick={() => {
                    setVisibleBranchLimit(canCollapseBranches ? MAX_BRANCH_ROWS : allBranchRows.length);
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: '10px 14px',
                    border: 'none',
                    borderTop: '1px solid var(--review-shell-divider)',
                    background: 'var(--review-shell-bg)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: 11.5,
                    fontWeight: 500,
                    fontFamily: 'var(--font-sans)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-hover)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--review-shell-bg)';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {canCollapseBranches ? <path d="M4 10l4-4 4 4" /> : <path d="M4 6l4 4 4-4" />}
                  </svg>
                  {canCollapseBranches
                    ? 'Show less'
                    : `Show ${hiddenBranchCount} more ${hiddenBranchCount === 1 ? 'branch' : 'branches'}`}
                  <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>
                    {visibleBranchRows.length} of {allBranchRows.length}
                  </span>
                </button>
              )}
            </div>
          )}
          <ProjectAnalytics metrics={analyticsMetrics} />
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div
            style={{
              padding: '16px 24px 10px',
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: -0.2, color: 'var(--text-primary)' }}>
                Pull Requests
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {prCards.filter((pr) => (pr.status !== 'closed' && pr.status !== 'merged')).length} active
                {latestSyncAt ? ` · ${syncLabel}` : ''}
                {prSearchActive ? ` · ${prSearchTotalMatches} match${prSearchTotalMatches === 1 ? '' : 'es'}` : ''}
              </div>
              {showPrSyncInlineError && (
                <div style={{ fontSize: 11.5, color: 'var(--status-warning, #d6a94c)', marginTop: 4 }}>
                  Refresh failed. Try again.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ position: 'relative', width: 240 }}>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 9,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-tertiary)',
                    opacity: 0.75,
                    pointerEvents: 'none',
                  }}
                >
                  <path
                    d="M6.8 2.2a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Zm0 1.2a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm3.95 6.5 3.15 3.15-.85.85-3.15-3.15.85-.85Z"
                    fill="currentColor"
                  />
                </svg>
                <input
                  ref={prSearchInputRef}
                  type="search"
                  value={prSearchQuery}
                  onChange={(event) => setPrSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      if (prSearchQuery) {
                        setPrSearchQuery('');
                      } else {
                        event.currentTarget.blur();
                      }
                    }
                  }}
                  placeholder="Search PRs by #, title, author… (press /)"
                  aria-label="Search pull requests"
                  spellCheck={false}
                  style={{
                    width: '100%',
                    height: 28,
                    padding: prSearchQuery ? '0 28px 0 28px' : '0 10px 0 28px',
                    borderRadius: 7,
                    border: '1px solid var(--border-muted)',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    fontSize: 12,
                    fontFamily: 'var(--font-ui)',
                    outline: 'none',
                  }}
                  onFocus={(event) => {
                    event.currentTarget.style.borderColor = 'color-mix(in oklab, var(--accent-blue) 45%, var(--border-muted))';
                  }}
                  onBlur={(event) => {
                    event.currentTarget.style.borderColor = 'var(--border-muted)';
                  }}
                />
                {prSearchQuery ? (
                  <button
                    type="button"
                    aria-label="Clear PR search"
                    onClick={() => setPrSearchQuery('')}
                    style={{
                      position: 'absolute',
                      right: 4,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      width: 20,
                      height: 20,
                      border: 0,
                      borderRadius: 5,
                      background: 'transparent',
                      color: 'var(--text-tertiary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.background = 'var(--bg-hover)';
                      event.currentTarget.style.color = 'var(--text-primary)';
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = 'transparent';
                      event.currentTarget.style.color = 'var(--text-tertiary)';
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="m4.15 3.3 3.85 3.85 3.85-3.85.85.85L8.85 8l3.85 3.85-.85.85L8 8.85 4.15 12.7l-.85-.85L7.15 8 3.3 4.15l.85-.85Z"
                        fill="currentColor"
                      />
                    </svg>
                  </button>
                ) : null}
              </div>
              <Btn
                variant="ghost"
                size="sm"
                onClick={() => { void syncPrReviews(); }}
                disabled={syncing}
                title="Pull latest pull request data from GitHub"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ animation: syncing ? 'atlas-spin 1s linear infinite' : undefined }}
                >
                  <path d="M14 8a6 6 0 1 1-1.76-4.24" />
                  <polyline points="14 3 14 7 10 7" />
                </svg>
                {syncing ? 'Refreshing…' : 'Refresh'}
              </Btn>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <div
              ref={prBoardRef}
              style={{
                height: '100%',
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 1,
                background: 'var(--review-shell-divider)',
                borderTop: '1px solid var(--review-shell-divider)',
                minHeight: 0,
              }}
            >
              <PRLane title="Ready to review" count={lane('ready').length} tint="med" accent="med">
                {showPrLoadingCards ? (
                  <>
                    <PRCardSkeleton delayMs={0} />
                    <PRCardSkeleton delayMs={120} />
                  </>
                ) : lane('ready').length === 0 ? (
                  <EmptyLaneCard message="No PRs awaiting your review" />
                ) : (
                  lane('ready').map((pr) => (
                    <PRCard
                      key={pr.id}
                      pr={pr}
                      laneKey="ready"
                      selected={selectedPrCardId === pr.id}
                      onFocusPr={(nextPr) => setSelectedPrCardId(nextPr.id)}
                      onNavigate={navigatePrCards}
                      onClick={() => onOpenReview({ projectId, kind: 'pr_review', id: pr.id })}
                    />
                  ))
                )}
              </PRLane>
              <PRLane title="Your PRs" count={lane('yours').length} tint="accent" accent="accent">
                {showPrLoadingCards ? (
                  <>
                    <PRCardSkeleton delayMs={80} />
                    <PRCardSkeleton delayMs={200} />
                  </>
                ) : lane('yours').length === 0 ? (
                  <EmptyLaneCard message="Open a PR from a tracked branch" withPlus />
                ) : (
                  lane('yours').map((pr) => (
                    <PRCard
                      key={pr.id}
                      pr={pr}
                      laneKey="yours"
                      selected={selectedPrCardId === pr.id}
                      onFocusPr={(nextPr) => setSelectedPrCardId(nextPr.id)}
                      onNavigate={navigatePrCards}
                      onClick={() => onOpenReview({ projectId, kind: 'pr_review', id: pr.id })}
                    />
                  ))
                )}
              </PRLane>
              <PRLane title="Others' PRs" count={lane('others').length}>
                {showPrLoadingCards ? (
                  <>
                    <PRCardSkeleton delayMs={160} />
                    <PRCardSkeleton delayMs={280} />
                    <PRCardSkeleton delayMs={400} />
                  </>
                ) : lane('others').length === 0 ? (
                  <EmptyLaneCard message="No open PRs from collaborators" />
                ) : (
                  lane('others').map((pr) => (
                    <PRCard
                      key={pr.id}
                      pr={pr}
                      laneKey="others"
                      selected={selectedPrCardId === pr.id}
                      onFocusPr={(nextPr) => setSelectedPrCardId(nextPr.id)}
                      onNavigate={navigatePrCards}
                      onClick={() => onOpenReview({ projectId, kind: 'pr_review', id: pr.id })}
                    />
                  ))
                )}
              </PRLane>
              <PRLane
                title="Recently completed"
                count={lane('completed').length}
                tint="ok"
                accent="ok"
              >
                {lane('completed').length === 0 ? (
                  <EmptyLaneCard message="No recently merged PRs" />
                ) : (
                  lane('completed').map((pr) => (
                    <PRCard
                      key={pr.id}
                      pr={pr}
                      laneKey="completed"
                      selected={selectedPrCardId === pr.id}
                      onFocusPr={(nextPr) => setSelectedPrCardId(nextPr.id)}
                      onNavigate={navigatePrCards}
                      onClick={() => onOpenReview({ projectId, kind: 'pr_review', id: pr.id })}
                    />
                  ))
                )}
              </PRLane>
            </div>
            {showPrGithubOverlay && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 24,
                  background: 'rgba(5, 8, 12, 0.58)',
                  backdropFilter: 'blur(2px)',
                  zIndex: 5,
                }}
              >
                <div
                  style={{
                    width: 'min(420px, 100%)',
                    border: '1px solid color-mix(in oklab, var(--accent-blue) 26%, var(--review-shell-divider))',
                    borderRadius: 10,
                    background: 'color-mix(in srgb, var(--review-panel-bg) 92%, transparent)',
                    boxShadow: '0 18px 60px rgba(0, 0, 0, 0.38)',
                    padding: '20px 22px',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 650, color: 'var(--text-primary)', marginBottom: 8 }}>
                    {prGithubOverlayTitle}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 16 }}>
                    {prGithubOverlayMessage}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                    <Btn
                      variant="primary"
                      size="sm"
                      onClick={() => { void openGitHubAppAccess(); }}
                      disabled={openingGitHubAppAccess || (!prSyncAccessDenied?.owner && !onOpenGlobalSettingsSection)}
                    >
                      {openingGitHubAppAccess ? 'Opening...' : prGithubPrimaryActionLabel}
                    </Btn>
                    <Btn
                      variant="ghost"
                      size="sm"
                      onClick={() => { void syncPrReviews(); }}
                      disabled={syncing}
                    >
                      {syncing ? 'Refreshing…' : 'Try again'}
                    </Btn>
                  </div>
                  {prSyncError && (
                    <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {prSyncError}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <ProjectHomeShortcutBar tab={tab} />
    </div>
  );
}

function ProjectHomeShortcutBar({ tab }: { tab: ProjectHomeTab }) {
  const refreshShortcut = formatShortcut(['primary', 'R']);
  const items = tab === 'branches'
    ? [
      'Enter/Space: open branch',
      'Esc: home',
      `${refreshShortcut}: refresh`,
      'j/k or ↑/↓: prev/next branch',
      '←/→: switch tab',
      '?: shortcuts',
    ]
    : [
      'Enter/Space: open focused PR',
      'Esc: home',
      `${refreshShortcut}: refresh`,
      'j/k or ↑/↓: prev/next PR',
      '←/→: switch tab',
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

function EmptyLaneCard({ message, withPlus = false }: { message: string; withPlus?: boolean }) {
  return (
    <div
      style={{
        border: '1px dashed var(--review-shell-divider)',
        borderRadius: 5,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        color: 'var(--text-tertiary)',
        fontSize: 11.5,
        fontFamily: 'var(--font-sans)',
      }}
    >
      {withPlus && (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="3" x2="8" y2="13" />
          <line x1="3" y1="8" x2="13" y2="8" />
        </svg>
      )}
      <span>{message}</span>
    </div>
  );
}

// Expose SevChip so tests can verify primitive re-use — no direct use here,
// but silencing the unused-import lint guard across the whole component tree.
void SevChip;

export default ProjectHome;
