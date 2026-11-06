/**
 * AtlasEngine MVP - Main Application
 * Modern tabbed layout: File Explorer | Tabbed Editor/Preview/Memory | Chat
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import toast, { Toaster } from '@/lib/toast';
import { useThemeInit } from './hooks/useThemeInit';
import FileTree from './components/FileTree';
import CodeEditor from './components/CodeEditor';
import PreviewPanel, { PreviewPanelHandle } from './components/PreviewPanel';
import MemoryPanel from './components/MemoryPanel';
import ChatPanel from './components/ChatPanel';
import AdminPanel from './components/AdminPanel';
import SettingsPanel from './components/SettingsPanel';
import { isProviderUsable } from '@/utils/providerStatus';
import TestPanel from './components/TestPanel';
import ChangeSetsPanel from './components/ChangeSetsPanel';
import DeploymentsPanel from './components/DeploymentsPanel';
import ReviewPanel from './components/ReviewPanel';
import HomePage from './components/HomePage';
import LandingPage from './components/LandingPage';
import TrustPipelineShell from './components/TrustPipelineShell';
import { CurrentUserProvider } from './contexts/CurrentUserContext';
import GitHubImportModal from './components/GitHubImportModal';
import ClaudeConnectModal from './components/ClaudeConnectModal';
import InputModal from './components/InputModal';
import GitHubButton from './components/GitHubButton';
import UpdateBanner from './components/UpdateBanner';
import GlobalSettingsModal, { type SettingsSection as GlobalSettingsSection } from './components/GlobalSettingsModal';
import PublishPanel from './components/PublishPanel';
import { usePopup } from './components/shared/PopupProvider';
import { loadPanelWidths, savePanelWidths } from './utils/panelWidths';
import { beginPanelResizeInteraction, endPanelResizeInteraction } from './utils/panelResizeInteraction';
import { createPendingProjectPrompt, type PendingProjectPrompt } from './utils/homePromptTransfer';
import { isTauriEnvironment } from './utils/tauri';
import { projectApi, uiEditsApi, testApi, atlasHostingApi, providerApi } from './services/api';
import type { Project, UiEditPayload, UiSelection, TestCase, StepResult, TestResult, RecordedAction } from './types';

interface Tab {
  id: string;
  type: 'file' | 'preview' | 'memory' | 'admin' | 'settings' | 'changesets' | 'deployments' | 'review';
  title: string;
  path?: string;
  content?: string;
  isDirty?: boolean;
  changesetId?: string;
}

type LeftPanelTab = 'files' | 'tests';
const NAVIGABLE_APP_TABS = new Set([
  'preview',
  'memory',
  'changesets',
  'deployments',
  'settings',
  'admin',
]);

const BUILDER_PANEL_WIDTHS_STORAGE_KEY = 'atlas_ui_builder_panel_widths_v1';
const BUILDER_LEFT_PANEL_DEFAULT_WIDTH = 240;
const BUILDER_LEFT_PANEL_MIN_WIDTH = 200;
const BUILDER_LEFT_PANEL_MAX_WIDTH = 600;
const BUILDER_RIGHT_PANEL_MIN_WIDTH = 360;
const BUILDER_RIGHT_PANEL_MAX_WIDTH = 800;

function clampBuilderPanelWidth(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getDefaultBuilderPanelWidths(viewportWidth: number): { leftWidth: number; rightWidth: number } {
  return {
    leftWidth: BUILDER_LEFT_PANEL_DEFAULT_WIDTH,
    rightWidth: Math.max(420, Math.round(viewportWidth * 0.30)),
  };
}

function getInitialBuilderPanelWidths(viewportWidth: number): { leftWidth: number; rightWidth: number } {
  const defaults = getDefaultBuilderPanelWidths(viewportWidth);
  const stored = loadPanelWidths(BUILDER_PANEL_WIDTHS_STORAGE_KEY);
  if (!stored) return defaults;
  return {
    leftWidth: clampBuilderPanelWidth(stored.leftWidth, BUILDER_LEFT_PANEL_MIN_WIDTH, BUILDER_LEFT_PANEL_MAX_WIDTH),
    rightWidth: clampBuilderPanelWidth(
      typeof stored.rightWidth === 'number' && Number.isFinite(stored.rightWidth)
        ? stored.rightWidth
        : defaults.rightWidth,
      BUILDER_RIGHT_PANEL_MIN_WIDTH,
      BUILDER_RIGHT_PANEL_MAX_WIDTH
    ),
  };
}

function App() {
  useThemeInit();
  const popup = usePopup();
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [editingProjectName, setEditingProjectName] = useState('');
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isEditingProjectName && projectNameInputRef.current) {
      projectNameInputRef.current.select();
    }
  }, [isEditingProjectName]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [leftPanelTab, setLeftPanelTab] = useState<LeftPanelTab>('files');
  const [showPublishPanel, setShowPublishPanel] = useState(false);
  const [publishTargetProjectId, setPublishTargetProjectId] = useState<string | null>(null);

  // Landing page: show on first visit or when URL contains #landing / ?landing=true
  // Never show in the desktop app (Tauri) — the landing page is for the website only.
  const [showLanding, setShowLanding] = useState<boolean>(() => {
    if (isTauriEnvironment()) return false;
    const hash = window.location.hash;
    const params = new URLSearchParams(window.location.search);
    if (hash === '#landing' || params.get('landing') === 'true') return true;
    return !localStorage.getItem('atlas_visited');
  });

  const handleOpenApp = useCallback(() => {
    setShowLanding(false);
    localStorage.setItem('atlas_visited', 'true');
    // Clean up URL hash/params if they forced landing
    if (window.location.hash === '#landing') {
      window.history.replaceState({}, '', window.location.pathname + window.location.search);
    }
    const params = new URLSearchParams(window.location.search);
    if (params.has('landing')) {
      params.delete('landing');
      const search = params.toString();
      const nextUrl = search ? `${window.location.pathname}?${search}` : window.location.pathname;
      window.history.replaceState({}, '', nextUrl);
    }
  }, []);

  const getProjectIdFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    return params.get('projectId') || params.get('project');
  };

  const setProjectIdInUrl = (projectId: string | null) => {
    const params = new URLSearchParams(window.location.search);

    if (projectId) {
      params.set('projectId', projectId);
      params.delete('project');
    } else {
      params.delete('projectId');
      params.delete('project');
    }

    const search = params.toString();
    const nextUrl = search ? `${window.location.pathname}?${search}` : window.location.pathname;
    window.history.replaceState({}, '', nextUrl);
  };

  // Panel widths (in pixels)
  const initialBuilderPanelWidthsRef = useRef(
    getInitialBuilderPanelWidths(typeof window !== 'undefined' ? window.innerWidth : 1440)
  );
  const [leftPanelWidth, setLeftPanelWidth] = useState(initialBuilderPanelWidthsRef.current.leftWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(initialBuilderPanelWidthsRef.current.rightWidth);
  const leftPanelWidthRef = useRef(initialBuilderPanelWidthsRef.current.leftWidth);
  const rightPanelWidthRef = useRef(initialBuilderPanelWidthsRef.current.rightWidth);

  // Use refs for smooth resizing
  const isResizingLeftRef = useRef(false);
  const isResizingRightRef = useRef(false);
  const animationFrameRef = useRef<number>();

  // Separate refresh channels so the file tree only remounts for structural changes.
  const [fileTreeRefreshCounter, setFileTreeRefreshCounter] = useState(0);
  const [previewRefreshCounter, setPreviewRefreshCounter] = useState(0);
  const [uiSelection, setUiSelection] = useState<UiSelection | null>(null);
  const [isSelectingUi, setIsSelectingUi] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [pendingScreenshotFile, setPendingScreenshotFile] = useState<File | null>(null);
  const [uiEditsActive, setUiEditsActive] = useState(false);
  const [uiEditEvent, setUiEditEvent] = useState<{
    id: number;
    type: 'apply' | 'reset';
    payload?: UiEditPayload;
  } | null>(null);
  const uiEditEventIdRef = useRef(0);

  // Test state (lifted from PreviewPanel)
  const previewPanelRef = useRef<PreviewPanelHandle>(null);
  const [isRunningTest, setIsRunningTest] = useState(false);
  const [runningTestId, setRunningTestId] = useState<string | null>(null);
  const [pickingElementForStep, setPickingElementForStep] = useState<number | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState<number | null>(null);
  const [stepResults, setStepResults] = useState<StepResult[]>([]);
  const [lastTestResult, setLastTestResult] = useState<TestResult | null>(null);
  const [selectorValidation, setSelectorValidation] = useState<{ stepIndex: number; matches: boolean; count: number } | null>(null);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordedSteps, setRecordedSteps] = useState<RecordedAction[]>([]);

  // External system messages for ChatPanel (e.g., Supabase placeholder notifications)
  const [pendingSystemMessage, setPendingSystemMessage] = useState<{
    content: string;
    tone?: 'success' | 'error' | 'warning';
  } | null>(null);
  // Deployment URL state
  const [lastDeploymentUrl, setLastDeploymentUrl] = useState<string | null>(null);
  const [lastDeploymentAt, setLastDeploymentAt] = useState<string | null>(null);

  // GitHub Import Modal state
  const [showGitHubImportModal, setShowGitHubImportModal] = useState(false);

  // Trust Pipeline dashboard refresh trigger (bumped after project creation/import)
  const [trustDashboardRefreshKey, setTrustDashboardRefreshKey] = useState(0);
  // Optimistic pending project path — set immediately when user picks a folder so a
  // placeholder card appears before the slow API call (watcher start, base detection) finishes.
  const [pendingProjectPath, setPendingProjectPath] = useState<string | null>(null);

  // Global Settings modal
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [globalSettingsSection, setGlobalSettingsSection] = useState<GlobalSettingsSection>('review');

  // Trust Pipeline modal states (InputModal fallback for browser — Tauri uses native dialog)
  const [showOpenFolderModal, setShowOpenFolderModal] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);

  // Cross-tab navigation: Build -> Review
  const [openInReviewProjectId, setOpenInReviewProjectId] = useState<string | null>(null);

  // Pending prompt to auto-send to AI chat after project creation from HomePage.
  // Scoped to a project to avoid sending it in a different repo after project switch.
  const [pendingPrompt, setPendingPrompt] = useState<PendingProjectPrompt | null>(null);

  // Open local folder: native dialog in Tauri, InputModal fallback in browser
  const openGlobalSettings = useCallback((section: GlobalSettingsSection = 'review') => {
    setGlobalSettingsSection(section);
    setShowGlobalSettings(true);
  }, []);

  const openLocalFolder = useCallback(async (localPath: string): Promise<Project | null> => {
    setPendingProjectPath(localPath.trim());
    try {
      const result = await projectApi.openLocal(localPath.trim());
      if (result.alreadyExists) {
        toast.success(`"${result.project.name}" is already added. Switched to existing project.`);
      } else {
        toast.success(
          result.project.hasGit
            ? `Added "${result.project.name}". Atlas is loading the repo in the background.`
            : `Added "${result.project.name}".`
        );
      }
      setTrustDashboardRefreshKey(k => k + 1);
      const p = result.project;
      return { ...p, hasMemory: false, status: 'active', updatedAt: p.createdAt } as Project;
    } catch (error: any) {
      console.error('Failed to open local folder:', error);
      const data = error?.response?.data;
      const errorCode: string | undefined = data?.errorCode;
      const errorMessage: string = data?.error || 'Failed to open folder. Check the path and try again.';

      if (errorCode === 'NOT_GIT_ROOT' && typeof data?.suggestedRoot === 'string') {
        const suggestedRoot: string = data.suggestedRoot;
        const choice = await popup.choose({
          title: 'Folder is not the repository root',
          message: (
            <div>
              <p style={{ margin: '0 0 8px' }}>
                Atlas tracks projects at the git repository root. The folder you picked is a subfolder of one.
              </p>
              <p style={{ margin: '0 0 6px' }}>Open the repository root instead?</p>
              <code
                style={{
                  display: 'block',
                  padding: '6px 8px',
                  background: 'var(--review-surface-muted, rgba(0,0,0,0.05))',
                  borderRadius: 4,
                  wordBreak: 'break-all',
                  fontSize: '0.85em',
                }}
              >
                {suggestedRoot}
              </code>
            </div>
          ),
          options: [
            { key: 'open-root', label: 'Open repository root', tone: 'primary' },
            { key: 'cancel', label: 'Cancel', tone: 'secondary' },
          ],
        });
        if (choice === 'open-root') {
          return openLocalFolder(suggestedRoot);
        }
        return null;
      }

      if (errorCode === 'NOT_A_GIT_REPO') {
        await popup.alert({
          title: 'Folder is not a git repository',
          message: (
            <div>
              <p style={{ margin: '0 0 8px' }}>
                Atlas only works with projects that are tracked in git.
              </p>
              <p style={{ margin: 0 }}>
                Choose a folder that already has git initialized, or run <code>git init</code> inside the folder first, then try again.
              </p>
            </div>
          ),
          okLabel: 'Got it',
        });
        return null;
      }

      toast.error(errorMessage);
      return null;
    } finally {
      setPendingProjectPath(null);
    }
  }, [popup]);

  const handleOpenLocalFolder = useCallback(async () => {
    const isTauri = isTauriEnvironment();
    let localPath: string | null = null;

    if (isTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Select project folder',
        });
        localPath = typeof selected === 'string' ? selected : null;
      } catch (err) {
        console.error('Native dialog failed, falling back to modal:', err);
        setShowOpenFolderModal(true);
        return;
      }
    } else {
      try {
        const result = await projectApi.pickLocalFolder();
        if (result.cancelled || !result.localPath) {
          return;
        }
        localPath = result.localPath;
      } catch (err) {
        console.error('Browser folder picker failed, falling back to modal:', err);
        setShowOpenFolderModal(true);
        return;
      }
    }

    if (!localPath) return;
    await openLocalFolder(localPath);
  }, [openLocalFolder]);

  const handleOpenLocalFolderForBuild = useCallback(async () => {
    const isTauri = isTauriEnvironment();
    let localPath: string | null = null;

    if (isTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({ directory: true, multiple: false, title: 'Select project folder' });
        localPath = typeof selected === 'string' ? selected : null;
      } catch (err) {
        console.error('Native dialog failed, falling back to modal:', err);
        setShowOpenFolderModal(true);
        return;
      }
    } else {
      try {
        const result = await projectApi.pickLocalFolder();
        if (result.cancelled || !result.localPath) return;
        localPath = result.localPath;
      } catch (err) {
        console.error('Browser folder picker failed, falling back to modal:', err);
        setShowOpenFolderModal(true);
        return;
      }
    }

    if (!localPath) return;
    const project = await openLocalFolder(localPath);
    if (project) {
      // Mark this local project as opened in Builder so it shows in the Build project list
      try {
        const stored = JSON.parse(localStorage.getItem('atlas_builder_local_projects') || '[]');
        if (!stored.includes(project.id)) {
          stored.push(project.id);
          localStorage.setItem('atlas_builder_local_projects', JSON.stringify(stored));
        }
      } catch { /* storage blocked */ }
      setCurrentProject(project);
      setProjectIdInUrl(project.id);
      setLeftPanelTab('files');
      setTabs([]);
    }
  }, [openLocalFolder]);

  // Claude Connect state - initialize from localStorage for instant display
  const [isClaudeConnected, setIsClaudeConnected] = useState<boolean | null>(() => {
    const cached = localStorage.getItem('claude_connected');
    return cached !== null ? cached === 'true' : null;
  });
  const [showClaudeConnectModal, setShowClaudeConnectModal] = useState(false);

  // Check Claude status on mount and periodically validate
  useEffect(() => {
    checkClaudeStatus();
  }, []);

  useEffect(() => {
    const handleProviderChanged = () => {
      void checkClaudeStatus();
    };
    window.addEventListener('provider-changed', handleProviderChanged);
    return () => window.removeEventListener('provider-changed', handleProviderChanged);
  }, [isClaudeConnected]);

  useEffect(() => {
    leftPanelWidthRef.current = leftPanelWidth;
  }, [leftPanelWidth]);

  useEffect(() => {
    rightPanelWidthRef.current = rightPanelWidth;
  }, [rightPanelWidth]);

  // Expose native hooks for desktop menu items.
  useEffect(() => {
    (window as any).__atlasNavigate = (tab: unknown) => {
      if (typeof tab !== 'string') return;
      const normalizedTab = tab.trim().toLowerCase();
      if (!NAVIGABLE_APP_TABS.has(normalizedTab)) {
        console.warn(`[App] Ignoring invalid navigation target: ${tab}`);
        return;
      }
      setActiveTabId(normalizedTab);
    };
    (window as any).__atlasOpenGlobalSettings = (section: unknown) => {
      const normalizedSection =
        typeof section === 'string' && section.trim().length > 0
          ? section.trim().toLowerCase()
          : 'review';
      openGlobalSettings(normalizedSection as GlobalSettingsSection);
    };
    return () => {
      delete (window as any).__atlasNavigate;
      delete (window as any).__atlasOpenGlobalSettings;
    };
  }, [openGlobalSettings]);

  // Persist Claude connection state to localStorage
  const updateClaudeConnected = (connected: boolean) => {
    setIsClaudeConnected(connected);
    localStorage.setItem('claude_connected', String(connected));
  };

  const checkClaudeStatus = async () => {
    try {
      const result = await providerApi.list();
      if (result.success && result.providers) {
        const anyConnected = result.providers.some(isProviderUsable);
        updateClaudeConnected(anyConnected);
      } else {
        updateClaudeConnected(false);
      }
    } catch (error) {
      console.error('Failed to check provider status:', error);
      // Only set to false if we don't have a cached value
      if (isClaudeConnected === null) {
        updateClaudeConnected(false);
      }
    }
  };

  // Load projects on mount and when returning to home page.
  // Only fire when currentProject becomes null (home), not when it transitions
  // null → project (which would re-fetch and overwrite freshly-created project state).
  const currentProjectId = currentProject?.id ?? null;
  useEffect(() => {
    if (currentProjectId === null) {
      loadProjects();
    }
  }, [currentProjectId]);

  // Handle mouse move for resizing with smooth performance
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Cancel any pending animation frame
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      // Use requestAnimationFrame for smooth 60fps updates
      animationFrameRef.current = requestAnimationFrame(() => {
        if (isResizingLeftRef.current) {
          const newWidth = clampBuilderPanelWidth(
            e.clientX,
            BUILDER_LEFT_PANEL_MIN_WIDTH,
            BUILDER_LEFT_PANEL_MAX_WIDTH
          );
          leftPanelWidthRef.current = newWidth;
          setLeftPanelWidth(newWidth);
        } else if (isResizingRightRef.current) {
          const newWidth = clampBuilderPanelWidth(
            window.innerWidth - e.clientX,
            BUILDER_RIGHT_PANEL_MIN_WIDTH,
            BUILDER_RIGHT_PANEL_MAX_WIDTH
          );
          rightPanelWidthRef.current = newWidth;
          setRightPanelWidth(newWidth);
        }
      });
    };

    const stopResizing = () => {
      const wasResizing = isResizingLeftRef.current || isResizingRightRef.current;
      isResizingLeftRef.current = false;
      isResizingRightRef.current = false;

      // Only run resize cleanup when we were actually resizing —
      // endPanelResizeInteraction calls removeAllRanges() which steals
      // focus from textareas when fired on every mouseup.
      if (wasResizing) {
        endPanelResizeInteraction();
      }

      // Cancel any pending animation frame
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      if (wasResizing) {
        savePanelWidths(BUILDER_PANEL_WIDTHS_STORAGE_KEY, {
          leftWidth: leftPanelWidthRef.current,
          rightWidth: rightPanelWidthRef.current,
        });
      }
    };

    // Add event listeners once at mount
    // Use window instead of document to catch events even outside the page
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopResizing);
    // Stop resizing if window loses focus (safety fallback)
    window.addEventListener('blur', stopResizing);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResizing);
      window.removeEventListener('blur', stopResizing);
      endPanelResizeInteraction();
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []); // Empty dependency array - listeners added once

  // Auto-open Preview, Memory, and Admin tabs when project loads
  useEffect(() => {
    if (currentProject && tabs.length === 0) {
      const previewTab: Tab = {
        id: 'preview',
        type: 'preview',
        title: 'Preview',
      };
      const memoryTab: Tab = {
        id: 'memory',
        type: 'memory',
        title: 'Memory',
      };
      const adminTab: Tab = {
        id: 'admin',
        type: 'admin',
        title: 'Admin',
      };
      const settingsTab: Tab = {
        id: 'settings',
        type: 'settings',
        title: 'Settings',
      };
      const changesetsTab: Tab = {
        id: 'changesets',
        type: 'changesets',
        title: 'Change Sets',
      };
      const deploymentsTab: Tab = {
        id: 'deployments',
        type: 'deployments',
        title: 'Deployments',
      };
      setTabs([previewTab, changesetsTab, deploymentsTab, memoryTab, settingsTab, adminTab]);
      setActiveTabId('preview');
    }
  }, [currentProject]);

  useEffect(() => {
    setUiSelection(null);
    setIsSelectingUi(false);
    setUiEditEvent(null);
    setUiEditsActive(false);
  }, [currentProject?.id]);

  // Ensure the explorer opens on Files whenever a project is opened/switched.
  useEffect(() => {
    if (currentProject?.id) {
      setLeftPanelTab('files');
    }
  }, [currentProject?.id]);

  // Load deployment history when project changes
  useEffect(() => {
    if (currentProject?.id) {
      loadDeploymentHistory(currentProject.id);
    } else {
      setLastDeploymentUrl(null);
      setLastDeploymentAt(null);
    }
  }, [currentProject?.id]);

  // Handle navigation events from other components
  useEffect(() => {
    const handleNavigateToChangesets = () => {
      setActiveTabId('changesets');
    };
    const handleNavigateToPreview = () => {
      setActiveTabId('preview');
    };
    window.addEventListener('atlas-navigate-to-changesets', handleNavigateToChangesets);
    window.addEventListener('atlas-navigate-to-preview', handleNavigateToPreview);
    return () => {
      window.removeEventListener('atlas-navigate-to-changesets', handleNavigateToChangesets);
      window.removeEventListener('atlas-navigate-to-preview', handleNavigateToPreview);
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    const loadUiEdits = async () => {
      if (!currentProject?.id) return;
      try {
        const response = await uiEditsApi.get(currentProject.id);
        const parsed = response?.content ? JSON.parse(response.content) : null;
        const hasEdits = Boolean(parsed && Array.isArray(parsed.edits) && parsed.edits.length > 0);
        if (isActive) {
          setUiEditsActive(hasEdits);
        }
      } catch (error) {
        if (isActive) {
          setUiEditsActive(false);
        }
      }
    };

    loadUiEdits();
    return () => {
      isActive = false;
    };
  }, [currentProject?.id]);

  const loadProjects = async () => {
    try {
      const response = await projectApi.list();
      const nextProjects = response.projects;
      setProjects(nextProjects);

      // Only auto-select if there's a projectId in the URL
      const urlProjectId = getProjectIdFromUrl();
      let nextProject: Project | null = null;

      if (urlProjectId) {
        nextProject = nextProjects.find((project) => project.id === urlProjectId) || null;
        // If URL has invalid projectId, clear it
        if (!nextProject) {
          setProjectIdInUrl(null);
        }
      }

      // Update current project if changed
      if (nextProject !== currentProject) {
        setCurrentProject(nextProject);
      }

      if (nextProject) {
        setProjectIdInUrl(nextProject.id);
      }
    } catch (error) {
      console.error('Failed to load projects:', error);
      toast.error('Failed to load projects. Please refresh the page.');
    }
  };

  // Load deployment history when project changes
  const loadDeploymentHistory = async (projectId: string) => {
    try {
      const response = await atlasHostingApi.getHistory(projectId, 1);
      setLastDeploymentUrl(response.lastDeploymentUrl);
      setLastDeploymentAt(response.lastDeploymentAt);
    } catch (error) {
      console.error('Failed to load deployment history:', error);
      setLastDeploymentUrl(null);
      setLastDeploymentAt(null);
    }
  };

  // Handle deployment completion from PublishPanel
  const handleDeploymentComplete = (url: string) => {
    setLastDeploymentUrl(url);
    setLastDeploymentAt(new Date().toISOString());
  };

  const openPublishPanel = useCallback((projectId: string) => {
    setPublishTargetProjectId(projectId);
    setShowPublishPanel(true);
  }, []);

  // New project creation from HomePage prompt
  const handleCreateProjectFromPrompt = async (
    name: string,
    description: string,
    files: File[] = [],
    options: {
      chatMode?: 'agent' | 'plan' | 'build';
      providerType?: string | null;
      modelAlias?: string | null;
    } = {},
  ) => {
    setIsCreatingProject(true);
    try {
      const response = await projectApi.create({
        name,
        description: description || undefined,
        framework: 'react',
        language: 'typescript',
      });

      setProjects([...projects, response.project]);
      setCurrentProject(response.project);
      setProjectIdInUrl(response.project.id);
      setLeftPanelTab('files');
      // Reset tabs so they auto-open for the new project
      setTabs([]);
      setActiveTabId(null);
      // Store prompt with project scope so it cannot auto-send in another project.
      setPendingPrompt(createPendingProjectPrompt(
        response.project.id,
        description,
        files,
        options,
      ));
      toast.success('Project created successfully!');
    } catch (error) {
      console.error('Failed to create project:', error);
      toast.error('Failed to create project. Please try again.');
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleProjectRenamed = useCallback((projectId: string, name: string) => {
    if (!projectId || !name) return;
    setCurrentProject((prev) => (prev?.id === projectId ? { ...prev, name } : prev));
    setProjects((prev) => prev.map((project) => (
      project.id === projectId ? { ...project, name } : project
    )));
  }, []);


  // New project creation from a template (no pending prompt — template already has code)
  const handleCreateFromTemplate = async (templateId: string, templateName: string) => {
    setIsCreatingProject(true);
    try {
      const response = await projectApi.create({
        name: templateName.toLowerCase().replace(/\s+/g, '-'),
        framework: 'react',
        language: 'typescript',
        templateId,
      });

      setProjects([...projects, response.project]);
      setCurrentProject(response.project);
      setProjectIdInUrl(response.project.id);
      setLeftPanelTab('files');
      setTabs([]);
      setActiveTabId(null);
      // No pendingPrompt — the template already has code
      setPendingPrompt(null);
      toast.success(`Project created from "${templateName}" template!`);
    } catch (error) {
      console.error('Failed to create project from template:', error);
      toast.error('Failed to create project from template. Please try again.');
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleSelectFile = (path: string, content: string) => {
    // Check if file is already open
    const existingTab = tabs.find((tab) => tab.type === 'file' && tab.path === path);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }

    // Create new tab
    const newTab: Tab = {
      id: `file-${Date.now()}`,
      type: 'file',
      title: path.split('/').pop() || path,
      path,
      content,
      isDirty: false,
    };

    setTabs([...tabs, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleUpdateFileContent = (tabId: string, content: string) => {
    setTabs(
      tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, content, isDirty: tab.content !== content }
          : tab
      )
    );
  };

  const handleSaveFile = async (tabId: string) => {
    if (!currentProject) return;

    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || tab.type !== 'file' || !tab.path || !tab.content) return;

    try {
      await projectApi.updateFileContent(currentProject.id, tab.path, tab.content);
      setTabs(
        tabs.map((t) =>
          t.id === tabId ? { ...t, isDirty: false } : t
        )
      );
      toast.success(`${tab.title} saved successfully`);
    } catch (error) {
      console.error('Failed to save file:', error);
      toast.error(`Failed to save ${tab.title}. Please try again.`);
    }
  };

  const handleCloseTab = async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);

    // Don't allow closing Preview, Memory, ChangeSets, Deployments, Settings, Admin tabs
    if (tab?.id === 'preview' || tab?.id === 'memory' || tab?.id === 'changesets' || tab?.id === 'deployments' || tab?.id === 'settings' || tab?.id === 'admin') {
      return;
    }

    if (tab?.isDirty) {
      const confirmed = await popup.confirm({
        title: 'Discard Unsaved Changes?',
        message: `File "${tab.title}" has unsaved changes. Close anyway?`,
        confirmLabel: 'Close without saving',
        cancelLabel: 'Keep open',
        danger: true,
      });
      if (!confirmed) {
        return;
      }
    }

    const newTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(newTabs);

    // Switch to another tab if closing active tab
    if (activeTabId === tabId) {
      if (newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      } else {
        setActiveTabId(null);
      }
    }
  };

  const handleFileTreeChange = () => {
    setFileTreeRefreshCounter((prev) => {
      const newCounter = prev + 1;
      console.log(`🌲 File tree refresh requested (counter: ${prev} → ${newCounter})`);
      return newCounter;
    });
  };

  const handlePreviewChange = () => {
    setPreviewRefreshCounter((prev) => {
      const newCounter = prev + 1;
      console.log(`🖥️ Preview refresh requested (counter: ${prev} → ${newCounter})`);
      return newCounter;
    });
  };

  const handleStartUiSelection = () => {
    setUiSelection(null);
    setIsSelectingUi(true);
    if (activeTabId !== 'preview') {
      setActiveTabId('preview');
    }
  };

  const handleClearUiSelection = () => {
    setUiSelection(null);
    setIsSelectingUi(false);
  };

  const handleUiSelection = (selection: UiSelection) => {
    setUiSelection(selection);
    setIsSelectingUi(false);
  };

  const handleUiEditsSaved = () => {
    setUiEditsActive(true);
    setUiSelection(null);
    setIsSelectingUi(false);
  };

  const handleStartScreenshot = () => {
    setIsCapturingScreenshot(true);
    setIsSelectingUi(false);
    if (activeTabId !== 'preview') {
      setActiveTabId('preview');
    }
  };

  const handleCancelScreenshot = () => {
    setIsCapturingScreenshot(false);
  };

  const handleScreenshotCaptured = (dataUrl: string) => {
    setIsCapturingScreenshot(false);
    // Empty dataUrl means screenshot failed — just clear capture mode
    if (!dataUrl) return;
    // Convert dataUrl to File object for the attachment pipeline
    try {
      const byteString = atob(dataUrl.split(',')[1]);
      const mimeString = dataUrl.split(',')[0].split(':')[1].split(';')[0];
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: mimeString });
      const file = new File([blob], `atlas-screenshot-${Date.now()}.png`, { type: 'image/png' });
      setPendingScreenshotFile(file);
    } catch (err) {
      console.error('Failed to convert screenshot to file:', err);
    }
  };

  const emitUiEditEvent = (event: { type: 'apply' | 'reset'; payload?: UiEditPayload }) => {
    uiEditEventIdRef.current += 1;
    setUiEditEvent({ id: uiEditEventIdRef.current, ...event });
  };

  const handleApplyUiEdit = (payload: UiEditPayload) => {
    emitUiEditEvent({ type: 'apply', payload });
  };

  const handleResetUiEdit = () => {
    emitUiEditEvent({ type: 'reset' });
  };

  // Handle GitHub import from modal — add to project list, stay on current tab
  const handleGitHubImported = (project: Project) => {
    setProjects(prev => [project, ...prev.filter((entry) => entry.id !== project.id)]);
    setShowGitHubImportModal(false);
    // Bump dashboard refresh so both Review and Build tabs re-fetch and show the new project
    setTrustDashboardRefreshKey(prev => prev + 1);
  };

  // Test handlers
  const handleRunTest = useCallback((test: TestCase) => {
    if (!previewPanelRef.current?.isIframeReady()) {
      toast.error('Preview not ready. Please wait for the page to load.');
      return;
    }

    // Reset state
    setStepResults([]);
    setCurrentStepIndex(0);
    setLastTestResult(null);
    setIsRunningTest(true);
    setRunningTestId(test.id);

    // Switch to Preview tab to see the test run
    setActiveTabId('preview');

    // Test runner is always injected, so we can run immediately
    // No URL change means no page reload
    previewPanelRef.current?.runTest(test);
  }, []);

  const handleStopTest = useCallback(() => {
    previewPanelRef.current?.stopTest();
    setIsRunningTest(false);
    setCurrentStepIndex(null);
    setRunningTestId(null);
  }, []);

  const handlePickElement = useCallback((stepIndex: number) => {
    console.log('[App] Pick element for step:', stepIndex);
    setPickingElementForStep(stepIndex);
    // Switch to Preview tab to pick the element
    setActiveTabId('preview');
    toast('Click an element in the preview to use its selector', { icon: '\uD83D\uDC46' });
  }, []);

  const handleCancelPick = useCallback(() => {
    if (pickingElementForStep !== null) {
      console.log('[App] Cancelling element pick');
      setPickingElementForStep(null);
    }
  }, [pickingElementForStep]);

  const handleValidateSelector = useCallback((selector: string, stepIndex: number) => {
    if (!previewPanelRef.current?.isIframeReady()) return;

    // Store which step we're validating
    (window as any).__atlasValidatingStep = stepIndex;

    previewPanelRef.current?.validateSelector(selector);
  }, []);

  const handleTestStepResult = useCallback((result: StepResult) => {
    setCurrentStepIndex(result.stepIndex + 1);
    setStepResults(prev => [...prev, result]);
  }, []);

  const handleTestComplete = useCallback((result: TestResult) => {
    setLastTestResult(result);
    setIsRunningTest(false);
    setCurrentStepIndex(null);

    // Save result to backend
    if (runningTestId && currentProject) {
      testApi.saveResult(currentProject.id, runningTestId, {
        status: result.status,
        steps: result.steps,
        duration: result.duration,
      }).catch(err => {
        console.error('Failed to save test result:', err);
      });
    }
    setRunningTestId(null);

    // Show toast notification
    if (result.status === 'pass') {
      toast.success(`Test passed! (${Math.round(result.duration)}ms)`);
    } else {
      toast.error('Test failed');
    }
  }, [runningTestId, currentProject]);

  const handleSelectorValidation = useCallback((validation: { matches: boolean; count: number }) => {
    setSelectorValidation({
      stepIndex: (window as any).__atlasValidatingStep ?? -1,
      matches: validation.matches,
      count: validation.count,
    });
  }, []);

  const handleElementPicked = useCallback((selector: string) => {
    if (pickingElementForStep !== null) {
      console.log('[App] Element picked for step:', pickingElementForStep, 'selector:', selector);
      setSelectorValidation(null);
      // Dispatch event for TestPanel to receive
      window.dispatchEvent(new CustomEvent('atlas-test-element-picked', {
        detail: { stepIndex: pickingElementForStep, selector }
      }));
      setPickingElementForStep(null);
    }
  }, [pickingElementForStep]);

  // Recording handlers
  const handleStartRecording = useCallback(() => {
    if (!previewPanelRef.current?.isIframeReady()) {
      toast.error('Preview not ready. Please wait for the page to load.');
      return;
    }

    setRecordedSteps([]);
    setIsRecording(true);
    setActiveTabId('preview'); // Switch to preview to see recording
    previewPanelRef.current?.startRecording();
    toast('Recording started - interact with the preview', { icon: '\uD83D\uDD34' });
  }, []);

  const handleStopRecording = useCallback(() => {
    previewPanelRef.current?.stopRecording();
    setIsRecording(false);
    setLeftPanelTab('tests'); // Switch to tests panel to see recorded steps
    toast.success(`Recording stopped - ${recordedSteps.length} action(s) captured`);
  }, [recordedSteps.length]);

  const handleRecordedAction = useCallback((action: RecordedAction) => {
    console.log('[App] Recorded action:', action);
    setRecordedSteps((prev) => [...prev, action]);
  }, []);

  const handleClearRecording = useCallback(() => {
    setRecordedSteps([]);
  }, []);

  // Handle selecting a project from HomePage
  const handleSelectProject = useCallback((project: Project) => {
    setCurrentProject(project);
    setProjectIdInUrl(project.id);
    setLeftPanelTab('files');
    setPendingPrompt((prev) => (
      prev?.projectId === project.id ? null : prev
    ));
    // Reset tabs so they auto-open for the new project
    setTabs([]);
    setActiveTabId(null);
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  // Show LandingPage for first-time visitors (or when forced via URL)
  if (showLanding && !currentProject) {
    return <LandingPage onOpenApp={handleOpenApp} />;
  }

  // Shared Toaster config used across all views
  const toasterElement = (
    <Toaster />
  );

  // Build the Atlas Builder content — either HomePage (no project), review-only message, or three-panel layout
  const atlasBuilderContent = !currentProject ? (
    <>
      <HomePage
        projects={projects}
        onCreateProject={handleCreateProjectFromPrompt}
        onCreateFromTemplate={handleCreateFromTemplate}
        onSelectProject={handleSelectProject}
        onGitHubImport={() => setShowGitHubImportModal(true)}
        onOpenLocalFolder={handleOpenLocalFolderForBuild}
        isCreatingProject={isCreatingProject}
        isClaudeConnected={isClaudeConnected}
        onConnectClick={() => setShowClaudeConnectModal(true)}
        onRefreshProjects={loadProjects}
        refreshKey={trustDashboardRefreshKey}
      />
    </>
  ) : (
    <div style={{ display: 'flex', height: '100%', background: 'var(--review-shell-bg)', color: 'var(--text-primary)', fontFamily: 'var(--font-sans)' }}>
      <>
          {/* Left Panel - File Explorer / Tests */}
          <div
            style={{
              width: leftPanelWidth,
              minWidth: leftPanelWidth,
              flexShrink: 0,
              background: 'var(--review-panel-bg)',
              borderRight: '1px solid var(--review-shell-border)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              boxShadow: 'var(--review-panel-shadow)',
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              height: 42,
              minHeight: 42,
              borderBottom: '1px solid var(--review-shell-border)',
              background: 'var(--review-panel-header-bg)',
              padding: '0 var(--space-3)',
              gap: 'var(--space-2)',
            }}>
              {currentProject ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentProject(null);
                      setProjectIdInUrl(null);
                      setLeftPanelTab('files');
                      setTabs([]);
                      setActiveTabId(null);
                    }}
                    title="Back to Home"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 24,
                      height: 24,
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--review-segment-bg)',
                      border: '1px solid var(--review-shell-border)',
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      transition: 'color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast)',
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = 'var(--text-primary)';
                      e.currentTarget.style.borderColor = 'var(--review-shell-border-strong)';
                      e.currentTarget.style.background = 'rgba(88, 166, 255, 0.08)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'var(--text-secondary)';
                      e.currentTarget.style.borderColor = 'var(--review-shell-border)';
                      e.currentTarget.style.background = 'var(--review-segment-bg)';
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </button>
                  {isEditingProjectName ? (
                    <input
                      ref={projectNameInputRef}
                      autoFocus
                      value={editingProjectName}
                      onChange={(e) => setEditingProjectName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                        } else if (e.key === 'Escape') {
                          setIsEditingProjectName(false);
                          setEditingProjectName(currentProject.name);
                        }
                      }}
                      onBlur={async () => {
                        const trimmed = editingProjectName.trim();
                        setIsEditingProjectName(false);
                        if (!trimmed || trimmed === currentProject.name) {
                          setEditingProjectName(currentProject.name);
                          return;
                        }
                        const name = trimmed.slice(0, 50);
                        try {
                          await projectApi.update(currentProject.id, { name });
                          handleProjectRenamed(currentProject.id, name);
                          toast.success('Project renamed');
                        } catch {
                          toast.error('Failed to rename project');
                          setEditingProjectName(currentProject.name);
                        }
                      }}
                      style={{
                        fontSize: 'var(--text-sm)',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--accent-blue)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '2px 6px',
                        outline: 'none',
                        width: '100%',
                        minWidth: 80,
                        fontFamily: 'inherit',
                      }}
                    />
                  ) : (
                    <span
                      onClick={() => {
                        setEditingProjectName(currentProject.name);
                        setIsEditingProjectName(true);
                      }}
                      title="Click to rename"
                      style={{
                        fontSize: 'var(--text-sm)',
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        cursor: 'pointer',
                      }}
                    >
                      {currentProject.name}
                    </span>
                  )}
                </>
              ) : (
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                  Home
                </span>
              )}
            </div>

            {/* Files / Tests Tab Bar — only shown when a project is open */}
            {currentProject && <div style={{ display: 'flex', borderBottom: '1px solid var(--review-shell-border)', background: 'rgba(9, 13, 22, 0.52)' }}>
              <button
                onClick={() => setLeftPanelTab('files')}
                style={{
                  flex: 1,
                  padding: '10px var(--space-4)',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  fontWeight: leftPanelTab === 'files' ? 600 : 400,
                  color: leftPanelTab === 'files' ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  background: leftPanelTab === 'files' ? 'rgba(88, 166, 255, 0.08)' : 'transparent',
                  border: 'none',
                  boxShadow: leftPanelTab === 'files' ? 'inset 0 -2px 0 var(--accent-blue)' : 'none',
                  cursor: 'pointer',
                  transition: 'color var(--transition-fast), background var(--transition-fast)',
                }}
              >
                Files
              </button>
              <button
                onClick={() => setLeftPanelTab('tests')}
                style={{
                  flex: 1,
                  padding: '10px var(--space-4)',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  fontWeight: leftPanelTab === 'tests' ? 600 : 400,
                  color: leftPanelTab === 'tests' ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  background: leftPanelTab === 'tests' ? 'rgba(88, 166, 255, 0.08)' : 'transparent',
                  border: 'none',
                  boxShadow: leftPanelTab === 'tests' ? 'inset 0 -2px 0 var(--accent-blue)' : 'none',
                  cursor: 'pointer',
                  transition: 'color var(--transition-fast), background var(--transition-fast)',
                }}
              >
                Tests
              </button>
            </div>}

            <div style={{ flex: 1, overflow: 'auto' }}>
              {!currentProject ? (
                <div style={{ padding: 'var(--space-3)' }}>
                  {projects.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {projects.map((project) => (
                        <button
                          key={project.id}
                          onClick={() => handleSelectProject(project)}
                          style={{
                            width: '100%',
                            padding: '6px 10px',
                            background: 'transparent',
                            border: 'none',
                            borderRadius: 'var(--radius-sm)',
                            fontSize: 'var(--text-sm)',
                            fontFamily: 'var(--font-sans)',
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'background var(--transition-fast), color var(--transition-fast)',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--bg-overlay)';
                            e.currentTarget.style.color = 'var(--text-primary)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                            e.currentTarget.style.color = 'var(--text-secondary)';
                          }}
                        >
                          {project.name}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', padding: '0 var(--space-2)' }}>
                      No projects yet
                    </p>
                  )}
                </div>
              ) : leftPanelTab === 'files' ? (
                <FileTree
                  key={`filetree-${currentProject.id}-${fileTreeRefreshCounter}`}
                  projectId={currentProject.id}
                  onSelectFile={handleSelectFile}
                />
              ) : (
                <TestPanel
                  projectId={currentProject.id}
                  onRunTest={handleRunTest}
                  onStopTest={handleStopTest}
                  onPickElement={handlePickElement}
                  onCancelPick={handleCancelPick}
                  onValidateSelector={handleValidateSelector}
                  isRunning={isRunningTest}
                  currentStepIndex={currentStepIndex}
                  stepResults={stepResults}
                  lastTestResult={lastTestResult}
                  selectorValidation={selectorValidation}
                  pickingStepIndex={pickingElementForStep}
                  isRecording={isRecording}
                  recordedSteps={recordedSteps}
                  onStartRecording={handleStartRecording}
                  onStopRecording={handleStopRecording}
                  onClearRecording={handleClearRecording}
                />
              )}
            </div>
          </div>

          {/* Left Resize Handle */}
          <div
            style={{
              width: 4,
              cursor: 'col-resize',
              background: 'transparent',
              transition: 'background var(--transition-fast)',
              flexShrink: 0,
            }}
            onMouseDown={(event) => {
              isResizingLeftRef.current = true;
              beginPanelResizeInteraction(event);
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(88, 166, 255, 0.24)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          />
      </>

      {/* Center Panel - Tabs */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--review-panel-alt-bg)' }}>
        {/* Tab Bar */}
        <div style={{
          height: 44,
          minHeight: 44,
          background: 'var(--review-panel-header-bg)',
          borderBottom: '1px solid var(--review-shell-border)',
          display: 'flex',
          alignItems: 'center',
          boxShadow: 'var(--review-topbar-shadow)',
        }}>
          {/* Tabs - scrollable area */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', overflowX: 'auto', height: '100%' }}>
            {tabs.map((tab) => (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 14px',
                  height: '100%',
                  cursor: 'pointer',
                  background: activeTabId === tab.id ? 'rgba(88, 166, 255, 0.08)' : 'transparent',
                  boxShadow: activeTabId === tab.id ? 'inset 0 -2px 0 var(--accent-blue)' : 'none',
                  transition: 'background var(--transition-fast), box-shadow var(--transition-fast)',
                }}
                onMouseEnter={(e) => {
                  if (activeTabId !== tab.id) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)';
                }}
                onMouseLeave={(e) => {
                  if (activeTabId !== tab.id) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span style={{
                  fontSize: 'var(--text-sm)',
                  whiteSpace: 'nowrap',
                  color: activeTabId === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: activeTabId === tab.id ? 600 : 400,
                }}>
                  {tab.title}
                  {tab.isDirty && <span style={{ marginLeft: 4, color: 'var(--accent-orange)' }}>&#9679;</span>}
                </span>
                {(tab.type === 'file' || tab.type === 'review') && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCloseTab(tab.id);
                    }}
                    style={{
                      marginLeft: 'var(--space-1)',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-tertiary)',
                      cursor: 'pointer',
                      transition: 'color var(--transition-fast)',
                      fontSize: 'var(--text-sm)',
                      padding: '0 2px',
                      lineHeight: 1,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = 'var(--text-primary)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'var(--text-tertiary)';
                    }}
                  >
                    &times;
                  </button>
                )}
              </div>
            ))}
            {tabs.length === 0 && (
              <div style={{ padding: '0 var(--space-4)', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                {currentProject ? 'Open a file from the explorer' : 'Select a project to get started'}
              </div>
            )}
          </div>

          {/* Right side buttons - Review + GitHub + Live Site (outside overflow container) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '0 var(--space-3)', flexShrink: 0 }}>
            {/* Review button - switches to Review tab for this project */}
            {currentProject && (
              <button
                type="button"
                onClick={() => setOpenInReviewProjectId(currentProject.id)}
                title="Open in Review tab"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '6px 12px',
                  background: 'var(--review-segment-bg)',
                  border: '1px solid var(--review-shell-border)',
                  borderRadius: 'var(--radius-lg)',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--text-tertiary)',
                  cursor: 'pointer',
                  transition: 'color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast)',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'var(--text-primary)';
                  e.currentTarget.style.borderColor = 'var(--review-shell-border-strong)';
                  e.currentTarget.style.background = 'rgba(88, 166, 255, 0.08)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--text-tertiary)';
                  e.currentTarget.style.borderColor = 'var(--review-shell-border)';
                  e.currentTarget.style.background = 'var(--review-segment-bg)';
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                Review
              </button>
            )}

            {/* Cloud Deploy Button */}
            {currentProject && (
              <button
                type="button"
                onClick={() => openPublishPanel(currentProject.id)}
                title="Deploy to cloud"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '6px 12px',
                  background: 'var(--review-segment-bg)',
                  border: '1px solid var(--review-shell-border)',
                  borderRadius: 'var(--radius-lg)',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--text-tertiary)',
                  cursor: 'pointer',
                  transition: 'color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast)',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'var(--accent-blue)';
                  e.currentTarget.style.borderColor = 'var(--accent-blue)';
                  e.currentTarget.style.background = 'rgba(88, 166, 255, 0.08)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--text-tertiary)';
                  e.currentTarget.style.borderColor = 'var(--review-shell-border)';
                  e.currentTarget.style.background = 'var(--review-segment-bg)';
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
                </svg>
                Cloud Deploy
              </button>
            )}

            {/* GitHub Button */}
            {currentProject && (
              <GitHubButton
                projectId={currentProject.id}
                projectName={currentProject.name}
              />
            )}

            {/* Live Site Button - shown when project has a deployed URL */}
            {lastDeploymentUrl && (
              <a
                href={lastDeploymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 12px',
                  background: 'rgba(63, 185, 80, 0.15)',
                  color: 'var(--accent-green)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 'var(--text-sm)',
                  border: '1px solid rgba(63, 185, 80, 0.3)',
                  textDecoration: 'none',
                  transition: 'background var(--transition-fast)',
                  whiteSpace: 'nowrap',
                }}
                title={lastDeploymentUrl}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(63, 185, 80, 0.25)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(63, 185, 80, 0.15)'; }}
              >
                <span style={{ width: 8, height: 8, background: 'var(--accent-green)', borderRadius: '50%' }} />
                Live Site
                <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            )}
          </div>
        </div>

        {/* Tab Content */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          {activeTab?.type === 'file' && (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <div style={{
                height: 40,
                minHeight: 40,
                background: 'var(--review-panel-header-bg)',
                borderBottom: '1px solid var(--review-shell-border)',
                display: 'flex',
                alignItems: 'center',
                padding: '0 var(--space-4)',
              }}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{activeTab.path}</span>
                {activeTab.isDirty && (
                  <button
                    onClick={() => handleSaveFile(activeTab.id)}
                    style={{
                      marginLeft: 'auto',
                      padding: '4px var(--space-3)',
                      background: 'rgba(88, 166, 255, 0.18)',
                      border: '1px solid rgba(88, 166, 255, 0.34)',
                      borderRadius: 'var(--radius-md)',
                      fontSize: 'var(--text-sm)',
                      fontFamily: 'var(--font-sans)',
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                      transition: 'opacity var(--transition-fast)',
                    }}
                  >
                    Save
                  </button>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <CodeEditor
                  value={activeTab.content || ''}
                  onChange={(value) => handleUpdateFileContent(activeTab.id, value)}
                  language={
                    activeTab.path?.endsWith('.ts') || activeTab.path?.endsWith('.tsx')
                      ? 'typescript'
                      : 'javascript'
                  }
                />
              </div>
            </div>
          )}
          {/* PreviewPanel is always mounted to keep ref available for tests */}
          {currentProject && (
            <div style={{ display: activeTab?.type === 'preview' ? 'block' : 'none', height: '100%' }}>
              <PreviewPanel
                ref={previewPanelRef}
                projectId={currentProject.id}
                isEngaged={
                  activeTab?.type === 'preview'
                  || isSelectingUi
                  || isCapturingScreenshot
                  || pickingElementForStep !== null
                  || isRunningTest
                  || isRecording
                }
                refreshKey={previewRefreshCounter}
                isSelectingUi={isSelectingUi}
                onUiSelection={handleUiSelection}
                uiEditEvent={uiEditEvent}
                uiSelection={uiSelection}
                uiEditsActive={uiEditsActive}
                isRunningTest={isRunningTest}
                pickingElementForStep={pickingElementForStep}
                onTestStepResult={handleTestStepResult}
                onTestComplete={handleTestComplete}
                onSelectorValidation={handleSelectorValidation}
                onElementPicked={handleElementPicked}
                isRecording={isRecording}
                onRecordedAction={handleRecordedAction}
                isCapturingScreenshot={isCapturingScreenshot}
                onScreenshotCaptured={handleScreenshotCaptured}
                onSystemChatMessage={setPendingSystemMessage}
              />
            </div>
          )}
          {activeTab?.type === 'memory' && currentProject && (
            <MemoryPanel projectId={currentProject.id} />
          )}
          {activeTab?.type === 'admin' && (
            <AdminPanel />
          )}
          {activeTab?.type === 'changesets' && currentProject && (
            <ChangeSetsPanel
              projectId={currentProject.id}
              lastDeploymentUrl={lastDeploymentUrl}
              lastDeploymentAt={lastDeploymentAt}
              onDeploymentComplete={handleDeploymentComplete}
              onOpenGlobalSettingsSection={(section) => openGlobalSettings(section)}
              onOpenReview={(changesetId, title) => {
                const reviewTabId = `review-${changesetId}`;
                setTabs(prev => [
                  ...prev.filter(t => t.id !== reviewTabId),
                  { id: reviewTabId, type: 'review', title: `Review: ${title}`, changesetId },
                ]);
                setActiveTabId(reviewTabId);
              }}
            />
          )}
          {activeTab?.type === 'deployments' && currentProject && (
            <DeploymentsPanel projectId={currentProject.id} />
          )}
          {activeTab?.type === 'review' && currentProject && activeTab.changesetId && (
            <ReviewPanel
              projectId={currentProject.id}
              changesetId={activeTab.changesetId}
              onClose={() => {
                // Close review tab and go back to changesets
                setTabs(prev => prev.filter(t => t.id !== activeTab.id));
                setActiveTabId('changesets');
              }}
              onNavigateToSettings={() => setActiveTabId('settings')}
              onNavigateToPublish={() => setActiveTabId('changesets')}
            />
          )}
          {activeTab?.type === 'settings' && currentProject && (
            <SettingsPanel
              projectId={currentProject.id}
              projectName={currentProject.name}
              onProjectRenamed={handleProjectRenamed}
              onProjectDeleted={() => {
                // Redirect to home or show projects list
                setCurrentProject(null);
                setProjectIdInUrl(null);
                setTabs([]);
                setActiveTabId(null);
                loadProjects();
                toast.success('Project deleted successfully. Please select another project.');
              }}
            />
          )}
          {!activeTab && currentProject && (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-2)' }}>Welcome to {currentProject.name}</p>
                <p style={{ fontSize: 'var(--text-sm)' }}>Open a file from the explorer or use the Preview/Memory tabs</p>
              </div>
            </div>
          )}
          {!currentProject && (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--space-2)' }}>No Project Selected</p>
                <p style={{ fontSize: 'var(--text-sm)' }}>Select or create a project to get started</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right Resize Handle */}
      <div
        style={{
          width: 4,
          cursor: 'col-resize',
          background: 'transparent',
          transition: 'background var(--transition-fast)',
          flexShrink: 0,
        }}
        onMouseDown={(event) => {
          isResizingRightRef.current = true;
          beginPanelResizeInteraction(event);
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-blue)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      />

      {/* Right Panel - Chat Only */}
      <div
        style={{
          width: rightPanelWidth,
          minWidth: rightPanelWidth,
          flexShrink: 0,
          background: 'var(--review-panel-bg)',
          borderLeft: '1px solid var(--review-shell-border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: 'var(--review-panel-shadow)',
        }}
      >
        {currentProject ? (
          <ChatPanel
            projectId={currentProject.id}
            onProjectRenamed={handleProjectRenamed}
            onFileChange={handlePreviewChange}
            onFileTreeChange={handleFileTreeChange}
            uiSelection={uiSelection}
            isSelectingUi={isSelectingUi}
            onStartUiSelection={handleStartUiSelection}
            onClearUiSelection={handleClearUiSelection}
            onApplyUiEdit={handleApplyUiEdit}
            onResetUiEdit={handleResetUiEdit}
            onUiEditsSaved={handleUiEditsSaved}
            isCapturingScreenshot={isCapturingScreenshot}
            onStartScreenshot={handleStartScreenshot}
            onCancelScreenshot={handleCancelScreenshot}
            pendingScreenshotFile={pendingScreenshotFile}
            onScreenshotFileConsumed={() => setPendingScreenshotFile(null)}
            initialPrompt={pendingPrompt?.projectId === currentProject.id ? pendingPrompt.prompt : null}
            initialFiles={pendingPrompt?.projectId === currentProject.id ? pendingPrompt.files : []}
            initialPromptMode={pendingPrompt?.projectId === currentProject.id ? pendingPrompt.chatMode : undefined}
            initialPromptProviderType={pendingPrompt?.projectId === currentProject.id ? pendingPrompt.providerType : null}
            initialPromptModelAlias={pendingPrompt?.projectId === currentProject.id ? pendingPrompt.modelAlias : null}
            initialPromptRequestId={pendingPrompt?.projectId === currentProject.id ? pendingPrompt.requestId : null}
            onInitialPromptConsumed={() => {
              setPendingPrompt((prev) => (
                prev?.projectId === currentProject.id ? null : prev
              ));
            }}
            pendingSystemMessage={pendingSystemMessage}
            onSystemMessageConsumed={() => setPendingSystemMessage(null)}
          />
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 'var(--text-sm)' }}>Select a project to start chatting</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <CurrentUserProvider>
      <UpdateBanner />
      {toasterElement}
      <TrustPipelineShell
        onSettingsClick={() => openGlobalSettings('review')}
        onGitHubImport={() => setShowGitHubImportModal(true)}
        onCreateProject={() => setShowNewProjectModal(true)}
        onOpenLocalFolder={handleOpenLocalFolder}
        onOpenGlobalSettingsSection={(section) => openGlobalSettings(section)}
        dashboardRefreshKey={trustDashboardRefreshKey}
        pendingProjectPath={pendingProjectPath}
        openInReviewProjectId={openInReviewProjectId}
        onOpenInReviewHandled={() => setOpenInReviewProjectId(null)}
      >
        {atlasBuilderContent}
      </TrustPipelineShell>
      <GitHubImportModal
        isOpen={showGitHubImportModal}
        onClose={() => setShowGitHubImportModal(false)}
        onImported={handleGitHubImported}
      />
      <ClaudeConnectModal
        isOpen={showClaudeConnectModal}
        onClose={() => setShowClaudeConnectModal(false)}
        onConnected={() => {
          updateClaudeConnected(true);
          checkClaudeStatus();
        }}
      />
      <InputModal
        isOpen={showOpenFolderModal}
        title="Open Local Folder"
        fields={[
          { label: 'Folder path', placeholder: '/path/to/your/project', required: true },
        ]}
        submitLabel="Open"
        onClose={() => setShowOpenFolderModal(false)}
        onSubmit={async ([localPath]) => {
          setShowOpenFolderModal(false);
          if (!localPath?.trim()) return;
          await openLocalFolder(localPath);
        }}
      />
      <GlobalSettingsModal
        isOpen={showGlobalSettings}
        onClose={() => setShowGlobalSettings(false)}
        initialSection={globalSettingsSection}
      />
      <PublishPanel
        isOpen={showPublishPanel}
        onClose={() => {
          setShowPublishPanel(false);
          setPublishTargetProjectId(null);
        }}
        projectId={publishTargetProjectId || currentProject?.id || ''}
        onDeploymentComplete={handleDeploymentComplete}
        onOpenGlobalSettingsSection={(section) => {
          setShowPublishPanel(false);
          setPublishTargetProjectId(null);
          openGlobalSettings(section);
        }}
      />
      <InputModal
        isOpen={showNewProjectModal}
        title="Create New Project"
        fields={[
          { label: 'Project name', placeholder: 'my-awesome-app', required: true },
          { label: 'Description', placeholder: 'A brief description of your project' },
        ]}
        submitLabel="Create"
        onClose={() => setShowNewProjectModal(false)}
        onSubmit={async ([name, description]) => {
          setShowNewProjectModal(false);
          if (!name?.trim()) return;
          try {
            await projectApi.create({
              name: name.trim(),
              description: description?.trim() || undefined,
              framework: 'react',
              language: 'typescript',
            });
            toast.success(`Project "${name.trim()}" created!`);
            setTrustDashboardRefreshKey(k => k + 1);
          } catch (error) {
            console.error('Failed to create project:', error);
            toast.error('Failed to create project. Please try again.');
          }
        }}
      />
    </CurrentUserProvider>
  );
}

export default App;
