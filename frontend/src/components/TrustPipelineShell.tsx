/**
 * TrustPipelineShell — Top-level tab shell
 * Wraps the app with two tabs: "Trust Pipeline" (default) and "Atlas Builder".
 * The Trust Pipeline tab is the hero view; Atlas Builder renders the existing app layout.
 */

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import TrustReviewView from './TrustReviewView';
import ProjectHome, { type ProjectHomeTab } from './ProjectHome';
import AllProjectsOverview from './AllProjectsOverview';
import ThemeToggle from './shared/ThemeToggle';
import SignInDialog from './auth/SignInDialog';
import { providerApi, settingsApi } from '@/services/api';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import { formatProviderModelBadgeLabel, pickShellProvider } from './trustPipelineShellUtils';
import atlasLogo from '../assets/atlas-logo.png';
import { reviewSurfaceStyle } from './review/ReviewChrome';
import { ENABLE_BUILDER } from '@/featureFlags';
import { applyFontScale } from '@/utils/uiScale';
import { formatShortcut } from '@/utils/keyboardShortcuts';
import { isProviderUsable } from '@/utils/providerStatus';

type ActiveTab = 'trust-pipeline' | 'atlas-builder';

interface TrustPipelineShellProps {
  /** The existing Atlas Builder content (three-panel layout from App.tsx) */
  children: ReactNode;
  /** Callback when Settings gear is clicked */
  onSettingsClick?: () => void;
  /** Callbacks for TrustDashboard action buttons */
  onOpenLocalFolder?: () => void;
  onGitHubImport?: () => void;
  onCreateProject?: () => void;
  /** Allows nested review views to jump directly to a settings section */
  onOpenGlobalSettingsSection?: (section: 'github' | 'cloud') => void;
  /** External refresh trigger — bumped by parent after project creation/import */
  dashboardRefreshKey?: number;
  /** Optimistic path shown as a loading card while the project is being added */
  pendingProjectPath?: string | null;
  /** When set, switch to Review tab and select this project. Reset to null after handling. */
  openInReviewProjectId?: string | null;
  /** Called after the review navigation has been handled, so parent can reset the trigger */
  onOpenInReviewHandled?: () => void;
}

const FONT_SIZE_OPTIONS = [
  { value: '90', label: '90%' },
  { value: '100', label: '100%' },
  { value: '110', label: '110%' },
  { value: '120', label: '120%' },
  { value: '130', label: '130%' },
];

function FontSizeButton() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('100');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    settingsApi.get('ui_scale').then((result) => {
      if (result.exists && result.value) setCurrent(result.value);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleSelect = async (value: string) => {
    setCurrent(value);
    applyFontScale(Number(value));
    setOpen(false);
    try { await settingsApi.set('ui_scale', value); } catch {}
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title="Font size"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 'var(--radius-md)',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          transition: 'color var(--transition-fast), background var(--transition-fast)',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'var(--font-sans)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--text-primary)';
          e.currentTarget.style.background = 'var(--bg-hover)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-secondary)';
          e.currentTarget.style.background = 'transparent';
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7V4h16v3" />
          <path d="M9 20h6" />
          <path d="M12 4v16" />
        </svg>
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: 32,
          right: 0,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          zIndex: 1000,
          minWidth: 100,
          padding: '4px 0',
        }}>
          {FONT_SIZE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleSelect(opt.value)}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 12px',
                fontSize: 12,
                fontFamily: 'var(--font-sans)',
                color: opt.value === current ? 'var(--accent-blue)' : 'var(--text-secondary)',
                fontWeight: opt.value === current ? 600 : 400,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background var(--transition-fast)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CurrentUserBadge({
  onOpenGlobalSettingsSection,
  onSettingsClick,
}: {
  onOpenGlobalSettingsSection?: (section: 'github' | 'cloud') => void;
  onSettingsClick?: () => void;
}) {
  const { user, loading } = useCurrentUser();
  const [signInOpen, setSignInOpen] = useState(false);

  const isGuest = !user || user.isGuest;

  if (loading && !user) {
    return null;
  }

  if (isGuest) {
    return (
      <>
        <button
          type="button"
          onClick={() => setSignInOpen(true)}
          title="Sign in with GitHub"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--text-secondary)',
            background: 'var(--bg-overlay)',
            border: '1px solid var(--border-muted)',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            transition: 'border-color var(--transition-fast), color var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-default)';
            e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--border-muted)';
            e.currentTarget.style.color = 'var(--text-secondary)';
          }}
        >
          Sign in
        </button>
        <SignInDialog open={signInOpen} onClose={() => setSignInOpen(false)} />
      </>
    );
  }

  const label = user?.github_login || user?.email || 'Account';
  const avatarUrl = user?.github_avatar_url || null;

  return (
    <button
      type="button"
      onClick={() => {
        if (onOpenGlobalSettingsSection) {
          onOpenGlobalSettingsSection('github');
        } else {
          onSettingsClick?.();
        }
      }}
      title={`Open GitHub settings for @${label}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px 2px 2px',
        fontSize: 12,
        fontWeight: 500,
        color: 'var(--text-primary)',
        background: 'var(--bg-overlay)',
        border: '1px solid var(--border-muted)',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
      }}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          width={20}
          height={20}
          style={{ borderRadius: '50%', display: 'block' }}
        />
      ) : (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: 'var(--bg-hover)',
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {String(label).slice(0, 1).toUpperCase()}
        </span>
      )}
      <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </button>
  );
}

function TrustPipelineShell({
  children,
  onSettingsClick,
  onOpenLocalFolder,
  onGitHubImport,
  onCreateProject,
  onOpenGlobalSettingsSection,
  dashboardRefreshKey = 0,
  pendingProjectPath,
  openInReviewProjectId,
  onOpenInReviewHandled,
}: TrustPipelineShellProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    if (!ENABLE_BUILDER) return 'trust-pipeline';
    const stored = localStorage.getItem('atlas_active_tab');
    if (stored === 'trust-pipeline' || stored === 'atlas-builder') return stored;
    return 'trust-pipeline';
  });

  // Selected project in the Trust Pipeline tab (null = show dashboard)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  /**
   * Phase 07 — inside a project, users first see ProjectHome (branches
   * table + PR lanes). Clicking a row/card promotes to 'review' with a
   * preset `reviewSelection`. `onBack` from the review view returns to
   * ProjectHome (not the all-projects overview).
   */
  const [projectView, setProjectView] = useState<'home' | 'review'>('home');
  const [projectHomeTab, setProjectHomeTab] = useState<ProjectHomeTab>('branches');
  const [reviewSelection, setReviewSelection] = useState<{
    id: string;
    type: 'branch_review' | 'pr_review' | 'workspace_review';
  } | null>(null);
  const [reviewBaseBranchName, setReviewBaseBranchName] = useState<string | null>(null);

  // Refresh key: bumped when switching to trust-pipeline tab to trigger re-fetch
  const [refreshKey, setRefreshKey] = useState(0);

  // Apply font size scale on mount
  useEffect(() => {
    settingsApi.get('ui_scale').then((result) => {
      if (result.exists && result.value) {
        applyFontScale(Number(result.value));
      }
    }).catch(() => {});
  }, []);

  // Provider info for top bar
  const [providerLabel, setProviderLabel] = useState<string | null>(null);
  const [providerConnected, setProviderConnected] = useState(false);

  const loadProviderInfo = useCallback(async () => {
    try {
      const context = activeTab === 'trust-pipeline' ? 'review' : 'build';
      const [providerList, contextActive, providerConfigs] = await Promise.all([
        providerApi.list(),
        providerApi.getContextActive(context),
        providerApi.getConfigs().catch(() => ({ success: false, configs: [] })),
      ]);

      const selectedProvider = pickShellProvider(
        providerList.providers || [],
        contextActive.data?.providerId || null,
        providerList.activeProvider || null,
      );

      if (selectedProvider) {
        setProviderLabel(formatProviderModelBadgeLabel(
          selectedProvider,
          contextActive.data?.model || selectedProvider.model,
          providerConfigs.configs || [],
        ));
        setProviderConnected(isProviderUsable(selectedProvider));
        return;
      }

      setProviderLabel(null);
      setProviderConnected(false);
    } catch {
      // Non-critical fetch errors should clear the badge rather than leaving
      // the previous provider visible for the wrong tab/context.
      setProviderLabel(null);
      setProviderConnected(false);
    }
  }, [activeTab]);

  useEffect(() => { loadProviderInfo(); }, [loadProviderInfo]);

  useEffect(() => {
    const handler = () => loadProviderInfo();
    window.addEventListener('provider-changed', handler);
    window.addEventListener('review-provider-changed', handler);
    window.addEventListener('build-provider-changed', handler);
    return () => {
      window.removeEventListener('provider-changed', handler);
      window.removeEventListener('review-provider-changed', handler);
      window.removeEventListener('build-provider-changed', handler);
    };
  }, [loadProviderInfo]);

  // Keyboard shortcut overlay
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false);

  const handleToggleShortcuts = useCallback(() => {
    setShowShortcutOverlay(prev => !prev);
  }, []);

  // Global keyboard listener for ? and Cmd/Ctrl+/ to toggle shortcut overlay
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      // ? key (without modifiers, just shift+/ which is ?)
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setShowShortcutOverlay(prev => !prev);
        return;
      }

      // Cmd+/ or Ctrl+/
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setShowShortcutOverlay(prev => !prev);
        return;
      }

      // Escape closes overlay if open
      if (e.key === 'Escape' && showShortcutOverlay) {
        e.preventDefault();
        e.stopPropagation();
        setShowShortcutOverlay(false);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showShortcutOverlay]);

  const handleSelectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setProjectView('home');
    setReviewSelection(null);
    setReviewBaseBranchName(null);
  }, []);

  const handleBackToDashboard = useCallback(() => {
    // From review → back to ProjectHome. From ProjectHome → back to
    // the all-projects overview (dashboard).
    setProjectView((prev) => {
      if (prev === 'review') {
        setReviewSelection(null);
        setReviewBaseBranchName(null);
        return 'home';
      }
      setSelectedProjectId(null);
      setReviewBaseBranchName(null);
      return 'home';
    });
  }, []);

  const handleOpenReview = useCallback(
    (payload: {
      projectId: string;
      kind: 'branch_review' | 'pr_review' | 'base_branch';
      id?: string;
      branchName?: string;
    }) => {
      setSelectedProjectId(payload.projectId);
      setProjectHomeTab(payload.kind === 'pr_review' ? 'prs' : 'branches');
      if (payload.kind === 'base_branch') {
        setReviewSelection(null);
        setReviewBaseBranchName(payload.branchName || null);
      } else if (payload.id) {
        setReviewSelection({ id: payload.id, type: payload.kind });
        setReviewBaseBranchName(null);
      }
      setProjectView('review');
    },
    [],
  );

  const handleOpenAllProjects = useCallback(() => {
    setSelectedProjectId(null);
    setProjectView('home');
    setReviewSelection(null);
    setReviewBaseBranchName(null);
  }, []);


  // Handle external request to open a project in Review tab
  useEffect(() => {
    if (openInReviewProjectId) {
      setActiveTab('trust-pipeline');
      localStorage.setItem('atlas_active_tab', 'trust-pipeline');
      setSelectedProjectId(openInReviewProjectId);
      setProjectView('review');
      setReviewSelection(null);
      setReviewBaseBranchName(null);
      setRefreshKey(prev => prev + 1);
      onOpenInReviewHandled?.();
    }
  }, [openInReviewProjectId, onOpenInReviewHandled]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: 'var(--bg-base)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 40,
          minHeight: 40,
          ...reviewSurfaceStyle({ variant: 'toolbar', padded: false }),
          borderRadius: 0,
          borderLeft: 'none',
          borderRight: 'none',
          borderTop: 'none',
          borderBottom: '1px solid var(--review-shell-divider)',
          boxShadow: 'var(--review-topbar-shadow)',
          padding: '0 var(--space-4)',
        }}
      >
        {/* Left: Logo — clicking returns to the All-projects overview. */}
        <div style={{ display: 'flex', alignItems: 'center', height: '100%', gap: 'var(--space-1)' }}>
          <button
            type="button"
            onClick={handleOpenAllProjects}
            title="All projects"
            aria-label="All projects"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 6px',
              margin: '0 -6px',
              border: 'none',
              background: 'transparent',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'background var(--transition-fast)',
              ...(ENABLE_BUILDER ? {
                paddingRight: 'var(--space-4)',
                marginRight: 'var(--space-2)',
                borderRight: '1px solid var(--border-default)',
              } : {}),
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-surface-raised)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <img src={atlasLogo} alt="AtlasEngine" style={{ width: 20, height: 20 }} />
            <span style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              color: 'var(--text-primary)',
              whiteSpace: 'nowrap',
            }}>
              AtlasEngine
            </span>
          </button>
        </div>

        {/* Right: Sign in / Provider status + Theme toggle + Settings gear */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <CurrentUserBadge
          onOpenGlobalSettingsSection={onOpenGlobalSettingsSection}
          onSettingsClick={onSettingsClick}
        />
        {providerLabel && (
          <button
            type="button"
            onClick={onSettingsClick}
            title="AI Provider settings"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              color: 'var(--text-tertiary)',
              padding: '2px 8px',
              background: 'var(--bg-overlay)',
              border: '1px solid var(--border-muted)',
              borderRadius: 'var(--radius-md)',
              marginRight: 'var(--space-1)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
              transition: 'border-color var(--transition-fast), color var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-default)';
              e.currentTarget.style.color = 'var(--text-secondary)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-muted)';
              e.currentTarget.style.color = 'var(--text-tertiary)';
            }}
          >
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: providerConnected ? 'var(--accent-green)' : 'var(--accent-red)',
              flexShrink: 0,
            }} />
            {providerLabel}
          </button>
        )}
        <ThemeToggle />
        <FontSizeButton />
        <button
          type="button"
          onClick={onSettingsClick}
          title="Settings"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-md)',
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            transition: 'color var(--transition-fast), background var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--text-primary)';
            e.currentTarget.style.background = 'var(--bg-hover)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-secondary)';
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {/* Trust Pipeline tab content */}
        <div
          style={{
            display: activeTab === 'trust-pipeline' ? 'flex' : 'none',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--bg-base)',
          }}
        >
          {selectedProjectId && projectView === 'review' ? (
            <TrustReviewView
              key={`${selectedProjectId}:${reviewSelection?.type || 'auto'}:${reviewSelection?.id || 'current'}`}
              projectId={selectedProjectId}
              activeProviderLabel={providerLabel}
              onBack={handleBackToDashboard}
              onShowShortcuts={handleToggleShortcuts}
              onOpenGlobalSettingsSection={onOpenGlobalSettingsSection}
              refreshKey={refreshKey}
              initialSelectedItem={reviewSelection}
              initialBaseBranchName={reviewBaseBranchName}
            />
          ) : selectedProjectId ? (
            <ProjectHome
              projectId={selectedProjectId}
              onOpenReview={handleOpenReview}
              onOpenAllProjects={handleOpenAllProjects}
              onSwitchProject={handleSelectProject}
              onAddProjectFromFolder={onOpenLocalFolder}
              onCreateProject={onCreateProject}
              onOpenGlobalSettingsSection={onOpenGlobalSettingsSection}
              activeTab={projectHomeTab}
              onTabChange={setProjectHomeTab}
              refreshKey={refreshKey + dashboardRefreshKey}
            />
          ) : (
            <AllProjectsOverview
              onOpenProject={handleSelectProject}
              onOpenLocalFolder={onOpenLocalFolder || (() => {})}
              onGitHubImport={onGitHubImport || (() => {})}
              onCreateProject={onCreateProject}
              pendingProjectPath={pendingProjectPath}
              refreshKey={refreshKey + dashboardRefreshKey}
            />
          )}
        </div>

        {/* Atlas Builder tab content — renders children (existing app layout) */}
        <div
          style={{
            display: activeTab === 'atlas-builder' ? 'flex' : 'none',
            flexDirection: 'column',
            height: '100%',
          }}
        >
          {children}
        </div>
      </div>

      {/* Keyboard shortcut overlay */}
      {showShortcutOverlay && (
        <ShortcutOverlay onClose={() => setShowShortcutOverlay(false)} />
      )}
    </div>
  );
}

/** Keyboard shortcut overlay modal */
function ShortcutOverlay({ onClose }: { onClose: () => void }) {
  const splitShortcut = formatShortcut(['primary', 'D']);
  const actionsShortcut = formatShortcut(['primary', 'enter']);
  const reviewShortcut = formatShortcut(['primary', 'R']);
  const fullReviewShortcut = formatShortcut(['primary', 'shift', 'R']);
  const askAtlasShortcut = formatShortcut(['primary', 'K']);
  const nextFileAlias = formatShortcut(['primary', 'shift', '[ / ]']);
  const shortcuts: Array<{ category: string; items: Array<{ key: string; description: string }> }> = [
    {
      category: 'Navigation',
      items: [
        { key: 'j / k', description: 'Previous / next change set' },
        { key: 'Esc', description: 'Back to project dashboard' },
      ],
    },
    {
      category: 'Diff Viewer',
      items: [
        { key: 'n / p', description: 'Previous / next hunk' },
        { key: `{ / } or ${nextFileAlias}`, description: 'Previous / next file' },
        { key: '[ / ]', description: 'Previous / next AI comment' },
        { key: splitShortcut, description: 'Toggle unified / split view' },
      ],
    },
    {
      category: 'Actions',
      items: [
        { key: actionsShortcut, description: 'Open Actions menu' },
        { key: reviewShortcut, description: 'Trigger AI review (incremental when possible)' },
        { key: fullReviewShortcut, description: 'Re-run full review (confirmation popup)' },
        { key: askAtlasShortcut, description: 'Open Ask Atlas chat' },
        { key: '?', description: 'Toggle this overlay' },
      ],
    },
  ];

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.7)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          padding: 'var(--space-6)',
          minWidth: 380,
          maxWidth: 480,
          fontFamily: 'var(--font-sans)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-5)',
        }}>
          <h3 style={{
            fontSize: 'var(--text-lg)',
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: 0,
          }}>
            Keyboard Shortcuts
          </h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 'var(--radius-sm)',
              background: 'transparent',
              border: 'none',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              fontSize: 'var(--text-lg)',
            }}
          >
            &times;
          </button>
        </div>

        {/* Shortcut categories */}
        {shortcuts.map((category) => (
          <div key={category.category} style={{ marginBottom: 'var(--space-4)' }}>
            <div style={{
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 'var(--space-2)',
            }}>
              {category.category}
            </div>
            {category.items.map((item) => (
              <div
                key={item.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: 'var(--space-1) 0',
                }}
              >
                <span style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-secondary)',
                }}>
                  {item.description}
                </span>
                <span style={{
                  display: 'inline-flex',
                  gap: 'var(--space-1)',
                }}>
                  {item.key.split(' / ').map((k, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                      {i > 0 && <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>/</span>}
                      <kbd style={{
                        display: 'inline-block',
                        padding: '1px var(--space-2)',
                        fontSize: 'var(--text-xs)',
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-primary)',
                        background: 'var(--bg-overlay)',
                        border: '1px solid var(--border-default)',
                        borderRadius: 'var(--radius-sm)',
                        lineHeight: 1.6,
                      }}>
                        {k.trim()}
                      </kbd>
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}

        {/* Footer hint */}
        <div style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--text-tertiary)',
          textAlign: 'center',
          paddingTop: 'var(--space-2)',
          borderTop: '1px solid var(--border-muted)',
        }}>
          Press <kbd style={{
            padding: '0 4px',
            fontSize: 'var(--text-xs)',
            fontFamily: 'var(--font-mono)',
            background: 'var(--bg-overlay)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-sm)',
          }}>?</kbd> or <kbd style={{
            padding: '0 4px',
            fontSize: 'var(--text-xs)',
            fontFamily: 'var(--font-mono)',
            background: 'var(--bg-overlay)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-sm)',
          }}>Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}

export default TrustPipelineShell;
export type { ActiveTab };
