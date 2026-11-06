/**
 * HomePage Component
 * Atlas Builder home screen — matches TrustDashboard design-token styling.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { changesetApi, watcherApi, projectApi, templateApi, cliAdaptersApi, providerApi, type CLIAdapter, type Template } from '@/services/api';
import type { Project, AIProvider, ChatMode } from '../types';
import { type ProjectTrustSummary } from './shared/ProjectCard';
import ProjectTabs from './shared/ProjectTabs';
import { ContextMenu } from './shared/ContextMenu';
import { ConfirmDialog } from './shared/ConfirmDialog';
import { FolderIcon, GitHubIcon, TemplateIcon } from './shared/icons';
import { getReviewActionButtonStyle } from './review/ReviewChrome';
import { pickPreferredBuildModelKey } from '@/utils/buildProviderSelection';
import { isTauriEnvironment } from '@/utils/tauri';
import { isProviderUsable } from '@/utils/providerStatus';
import { ENABLE_BUILDER } from '@/featureFlags';
import toast from '@/lib/toast';

const AUTO_PROJECT_PLACEHOLDER = 'untitled-project';
const SUMMARY_BOOTSTRAP_GRACE_MS = 15000;
const SUMMARY_RETRY_MS = 2000;

function parseProjectCreatedAt(value: string | null | undefined): number | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const normalizedWithTimezone = hasExplicitTimezone ? normalized : `${normalized}Z`;
  const normalizedTs = new Date(normalizedWithTimezone).getTime();
  return Number.isFinite(normalizedTs) ? normalizedTs : null;
}

function hasMeaningfulBuildSummary(summary: ProjectTrustSummary | undefined): boolean {
  if (!summary) return false;
  return Boolean(
    summary.branch
    || summary.watching
    || (summary.totalChangesets ?? 0) > 0
    || (summary.reviewedCount ?? 0) > 0
    || (summary.unreviewedCount ?? 0) > 0
    || (summary.highRiskCount ?? 0) > 0
    || summary.latestRisk
  );
}

function shouldKeepSummaryPending(project: Project, summary: ProjectTrustSummary | undefined): boolean {
  if (hasMeaningfulBuildSummary(summary)) return false;
  const createdAtMs = parseProjectCreatedAt(project.createdAt);
  if (createdAtMs === null) return false;
  return (Date.now() - createdAtMs) < SUMMARY_BOOTSTRAP_GRACE_MS;
}

interface ModelOption {
  key: string;
  providerType: string;
  providerName: string;
  alias: string;
  name: string;
  description: string;
  isDefault: boolean;
}

interface HomePageProps {
  projects: Project[];
  onCreateProject: (
    name: string,
    description: string,
    files?: File[],
    options?: {
      chatMode?: ChatMode;
      providerType?: string | null;
      modelAlias?: string | null;
    }
  ) => void;
  onCreateFromTemplate: (templateId: string, templateName: string) => void;
  onSelectProject: (project: Project) => void;
  onGitHubImport: () => void;
  onOpenLocalFolder: () => void;
  isCreatingProject: boolean;
  isClaudeConnected?: boolean | null; // null = loading
  onConnectClick?: () => void;
  /** Refresh the project list (called after removing a project) */
  onRefreshProjects?: () => void;
  refreshKey?: number;
}

function HomePage({
  projects,
  onCreateProject,
  onCreateFromTemplate,
  onSelectProject,
  onGitHubImport,
  onOpenLocalFolder,
  isCreatingProject,
  onRefreshProjects,
}: HomePageProps) {
  const [prompt, setPrompt] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [trustSummaries, setTrustSummaries] = useState<Record<string, ProjectTrustSummary>>({});
  const [loadingSummaries, setLoadingSummaries] = useState(false);
  const [loadingSummaryProjectIds, setLoadingSummaryProjectIds] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const summaryRequestSeqRef = useRef(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; project: Project } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Project | null>(null);

  // Template state
  const [templates, setTemplates] = useState<Template[]>([]);

  // Model selector state
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [connectedProviders, setConnectedProviders] = useState<AIProvider[]>([]);
  const [buildContextActive, setBuildContextActive] = useState<{ providerId: string; model: string | null } | null>(null);

  // Chat mode state (matches ChatPanel's Agent/Plan/Build selector)
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    try { return (localStorage.getItem('atlas_chat_mode') as ChatMode) || 'agent'; }
    catch { return 'agent'; }
  });

  const selectedModelOption = useMemo(
    () => availableModels.find((m) => m.key === selectedModel) || null,
    [availableModels, selectedModel],
  );

  // Load templates on mount
  useEffect(() => {
    templateApi.list()
      .then((res) => { if (res.success) setTemplates(res.templates); })
      .catch(() => { /* graceful fallback — no templates shown */ });
  }, []);

  // Load available CLI adapters / models on mount
  useEffect(() => {
    const fetchModels = async () => {
      setIsLoadingModels(true);
      try {
        const [adapterResult, providerResult, contextResult] = await Promise.allSettled([
          cliAdaptersApi.list(),
          providerApi.list(),
          providerApi.getContextActive('build'),
        ]);

        if (providerResult.status === 'fulfilled') {
          setConnectedProviders(providerResult.value.providers || []);
        }
        if (contextResult.status === 'fulfilled') {
          setBuildContextActive(contextResult.value.data || null);
        }

        if (adapterResult.status === 'fulfilled' && adapterResult.value.success && adapterResult.value.adapters) {
          const response = adapterResult.value;
          const supported = response.adapters.filter((a: CLIAdapter) => a.supported);
          const options: ModelOption[] = supported.flatMap((adapter: CLIAdapter) =>
            (adapter.models || []).map((model) => ({
              key: `${adapter.type}:${model.alias}`,
              providerType: adapter.type,
              providerName: adapter.name,
              alias: model.alias,
              name: model.name,
              description: model.description || '',
              isDefault: Boolean(adapter.defaultModel && adapter.defaultModel === model.alias),
            })),
          );
          setAvailableModels(options);
        }
      } catch (err) {
        console.error('[HomePage] Failed to load models:', err);
      } finally {
        setIsLoadingModels(false);
      }
    };
    fetchModels();
  }, []);

  useEffect(() => {
    const refreshProviderPreferences = async () => {
      try {
        const [providersResult, contextResult] = await Promise.all([
          providerApi.list(),
          providerApi.getContextActive('build'),
        ]);
        setConnectedProviders(providersResult.providers || []);
        setBuildContextActive(contextResult.data || null);
      } catch {
        // silent
      }
    };

    const handleProviderChanged = () => { void refreshProviderPreferences(); };
    window.addEventListener('provider-changed', handleProviderChanged);
    window.addEventListener('build-provider-changed', handleProviderChanged);
    return () => {
      window.removeEventListener('provider-changed', handleProviderChanged);
      window.removeEventListener('build-provider-changed', handleProviderChanged);
    };
  }, []);

  // Select default model (same fallback chain as ChatPanel)
  useEffect(() => {
    if (availableModels.length === 0) return;

    const hasModel = (key: string | null | undefined) =>
      Boolean(key) && availableModels.some((m) => m.key === key);
    const connectedTypes = new Set(
      connectedProviders
        .filter(isProviderUsable)
        .map((provider) => provider.type),
    );
    const isConnectedModel = (key: string | null | undefined) => {
      const match = availableModels.find((model) => model.key === key);
      if (!match) return false;
      return connectedTypes.size === 0 || connectedTypes.has(match.providerType as AIProvider['type']);
    };

    if (hasModel(selectedModel) && isConnectedModel(selectedModel)) return;

    // Check localStorage for prior selection
    try {
      const preferredKey = pickPreferredBuildModelKey(availableModels, connectedProviders, {
        contextActive: buildContextActive,
        storedCombined: localStorage.getItem('atlas_selected_cli_model'),
        storedProvider: localStorage.getItem('atlas_selected_cli'),
      });
      if (preferredKey && preferredKey !== selectedModel) {
        setSelectedModel(preferredKey);
        return;
      }
    } catch { /* storage blocked */ }

    // Global default
    const fallback = availableModels.find((m) => m.isDefault) || availableModels[0];
    setSelectedModel(fallback.key);
  }, [availableModels, buildContextActive, connectedProviders, selectedModel]);

  // Persist model selection to localStorage
  useEffect(() => {
    if (!selectedModelOption) return;
    try {
      localStorage.setItem('atlas_selected_cli_model', selectedModelOption.key);
      localStorage.setItem('atlas_selected_model', selectedModelOption.alias);
      localStorage.setItem('atlas_selected_cli', selectedModelOption.providerType);
    } catch { /* storage blocked */ }
  }, [selectedModelOption]);

  // Build tab shows builder + GitHub + local projects explicitly opened in Builder
  const builderLocalIds = useMemo(() => {
    try { return new Set(JSON.parse(localStorage.getItem('atlas_builder_local_projects') || '[]')); }
    catch { return new Set(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]); // re-read when projects list changes
  const builderProjects = useMemo(
    () => projects.filter(p => !p.source || p.source === 'builder' || p.source === 'github' || builderLocalIds.has(p.id)),
    [projects, builderLocalIds],
  );
  const sortedProjects = [...builderProjects].sort((a, b) => {
    const dateA = new Date(a.lastModified || a.lastAccessed || a.updatedAt || a.createdAt).getTime();
    const dateB = new Date(b.lastModified || b.lastAccessed || b.updatedAt || b.createdAt).getTime();
    return dateB - dateA;
  });

  // Fetch trust summaries for builder projects only
  const fetchTrustSummaries = useCallback(async (requestedProjectIds?: Set<string>) => {
    if (builderProjects.length === 0) {
      setTrustSummaries({});
      setLoadingSummaries(false);
      setLoadingSummaryProjectIds(new Set());
      return;
    }
    const requestSeq = summaryRequestSeqRef.current + 1;
    summaryRequestSeqRef.current = requestSeq;
    const projectIds = builderProjects.map((project) => project.id);
    const visibleProjectIds = new Set(projectIds);
    const activePendingIds = requestedProjectIds && requestedProjectIds.size > 0
      ? new Set(Array.from(requestedProjectIds).filter((projectId) => visibleProjectIds.has(projectId)))
      : new Set(projectIds);
    const projectsToFetch = builderProjects.filter((project) => activePendingIds.has(project.id));
    if (projectsToFetch.length === 0) {
      setLoadingSummaries(false);
      setLoadingSummaryProjectIds(new Set());
      return;
    }
    setLoadingSummaries(projectsToFetch.length === projectIds.length);
    setLoadingSummaryProjectIds(new Set(activePendingIds));
    setTrustSummaries((prev) => {
      const next: Record<string, ProjectTrustSummary> = {};
      for (const project of builderProjects) {
        if (prev[project.id]) next[project.id] = prev[project.id];
      }
      return next;
    });
    await Promise.allSettled(
      projectsToFetch.map(async (project) => {
        let summary: ProjectTrustSummary;
        try {
          const [csResult, watcherResult] = await Promise.allSettled([
            changesetApi.list(project.id),
            watcherApi.getStatus(project.id),
          ]);

          const changesets = csResult.status === 'fulfilled' ? csResult.value.changesets : [];
          const watching = watcherResult.status === 'fulfilled' ? watcherResult.value.watching : false;
          const branch = watcherResult.status === 'fulfilled' && watcherResult.value.status?.branch
            ? watcherResult.value.status.branch
            : null;

          const reviewed = changesets.filter((cs: any) => cs.reviewStatus === 'reviewed');
          const unreviewed = changesets.filter((cs: any) => !cs.reviewStatus || cs.reviewStatus === 'none');
          const highRisk = changesets.filter((cs: any) => cs.reviewRiskLevel === 'high' || cs.reviewRiskLevel === 'critical');
          const latestNonBaseline = changesets.find((cs: any) => cs.source !== 'baseline');
          const latestRisk = latestNonBaseline?.reviewRiskLevel || null;

          summary = {
            totalChangesets: changesets.length,
            reviewedCount: reviewed.length,
            unreviewedCount: unreviewed.length,
            highRiskCount: highRisk.length,
            latestRisk,
            branch,
            watching,
          };
        } catch {
          summary = {
            totalChangesets: 0,
            reviewedCount: 0,
            unreviewedCount: 0,
            highRiskCount: 0,
            latestRisk: null,
            branch: null,
            watching: false,
          };
        }
        if (summaryRequestSeqRef.current !== requestSeq) return;
        const keepPending = shouldKeepSummaryPending(project, summary);
        setTrustSummaries((prev) => ({
          ...(keepPending ? prev : {
            ...prev,
            [project.id]: summary,
          }),
        }));
        setLoadingSummaryProjectIds((prev) => {
          const next = new Set(prev);
          if (!keepPending) {
            next.delete(project.id);
          }
          return next;
        });
      })
    );
    if (summaryRequestSeqRef.current === requestSeq) {
      setLoadingSummaries(false);
    }
  }, [builderProjects]);

  useEffect(() => {
    if (builderProjects.length > 0) {
      fetchTrustSummaries();
    }
  }, [builderProjects, fetchTrustSummaries]);

  useEffect(() => {
    if (loadingSummaryProjectIds.size === 0) return;
    const pendingIds = new Set(loadingSummaryProjectIds);
    const timeoutId = window.setTimeout(() => {
      void fetchTrustSummaries(pendingIds);
    }, SUMMARY_RETRY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [loadingSummaryProjectIds, fetchTrustSummaries]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim() || isCreatingProject) return;

    onCreateProject(AUTO_PROJECT_PLACEHOLDER, prompt.trim(), selectedFiles, {
      chatMode,
      providerType: selectedModelOption?.providerType || null,
      modelAlias: selectedModelOption?.alias || null,
    });
    setPrompt('');
    setSelectedFiles([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Show expanded (textarea) when focused or has content
  const isExpanded = isFocused || prompt.length > 0;
  const focusPromptComposer = () => {
    inputRef.current?.focus();
    inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const validateAndAddFiles = useCallback((files: File[]) => {
    const maxSize = 10 * 1024 * 1024;
    const allowedTypes = new Set([
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css',
      'application/pdf', 'application/json',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);
    const allowedExtensions = new Set([
      'txt', 'md', 'csv', 'html', 'css', 'json', 'pdf', 'doc', 'docx', 'xls', 'xlsx',
      'jpg', 'jpeg', 'png', 'gif', 'webp',
    ]);
    const maxFiles = 20;
    const rejected: string[] = [];

    const validFiles = files.filter((file) => {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (!allowedTypes.has(file.type) && !allowedExtensions.has(ext)) {
        rejected.push(`${file.name}: unsupported type`);
        return false;
      }
      if (file.size > maxSize) {
        rejected.push(`${file.name}: exceeds 10 MB`);
        return false;
      }
      return true;
    });

    setSelectedFiles((prev) => {
      const remainingSlots = Math.max(0, maxFiles - prev.length);
      const acceptedFiles = validFiles.slice(0, remainingSlots);
      if (validFiles.length > acceptedFiles.length) {
        const skippedCount = validFiles.length - acceptedFiles.length;
        rejected.push(`${skippedCount} file${skippedCount === 1 ? '' : 's'}: max ${maxFiles} attachments`);
      }
      return [...prev, ...acceptedFiles];
    });

    if (rejected.length > 0) {
      toast.error(`Some files were skipped:\n${rejected.slice(0, 3).join('\n')}`);
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    validateAndAddFiles(files);
    e.target.value = '';
  }, [validateAndAddFiles]);

  const handleRemoveFile = useCallback((index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAttachClick = useCallback(async () => {
    const isTauri = isTauriEnvironment();
    if (isTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          multiple: true,
          title: 'Attach files',
          filters: [
            { name: 'All Supported', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'txt', 'md', 'csv', 'html', 'css', 'json', 'pdf', 'doc', 'docx', 'xls', 'xlsx'] },
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
            { name: 'Documents', extensions: ['txt', 'md', 'csv', 'html', 'css', 'json', 'pdf', 'doc', 'docx', 'xls', 'xlsx'] },
          ],
        });
        if (!selected) return;

        const paths = Array.isArray(selected) ? selected : [selected];
        const { readFile } = await import('@tauri-apps/plugin-fs');
        const mimeMap: Record<string, string> = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
          txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', css: 'text/css',
          json: 'application/json', pdf: 'application/pdf',
          doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };

        const fileObjects: File[] = [];
        for (const filePath of paths) {
          try {
            const data = await readFile(filePath);
            const name = filePath.split('/').pop() || filePath.split('\\').pop() || 'file';
            const ext = name.split('.').pop()?.toLowerCase() || '';
            const mime = mimeMap[ext] || 'application/octet-stream';
            fileObjects.push(new File([data], name, { type: mime }));
          } catch (err) {
            console.error(`Failed to read file ${filePath}:`, err);
          }
        }

        if (fileObjects.length > 0) validateAndAddFiles(fileObjects);
      } catch (err) {
        console.error('Tauri file dialog failed, falling back to HTML input:', err);
        fileInputRef.current?.click();
      }
      return;
    }

    fileInputRef.current?.click();
  }, [validateAndAddFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = Array.from(e.dataTransfer.files || []);
    validateAndAddFiles(files);
  }, [validateAndAddFiles]);

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        background: 'var(--review-shell-bg)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: 'var(--space-6) var(--space-6) var(--space-8)' }}>
        {/* Header */}
        <div style={{ marginBottom: 'var(--space-6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div>
            <h2 className="review-shell-title" style={{ fontSize: '34px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Projects
            </h2>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginTop: 'var(--space-2)', marginBottom: 0 }}>
              {builderProjects.length} project{builderProjects.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <HeaderActionButton onClick={onOpenLocalFolder}>
              <FolderIcon />
              Open Local Folder
            </HeaderActionButton>
            <HeaderActionButton onClick={onGitHubImport}>
              <GitHubIcon />
              GitHub
            </HeaderActionButton>
            {ENABLE_BUILDER && (
              <HeaderActionButton onClick={focusPromptComposer} primary>
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
                New
              </HeaderActionButton>
            )}
          </div>
        </div>

        {/* Prompt Input — larger textarea with bottom bar */}
        {ENABLE_BUILDER && (
        <form onSubmit={handleSubmit} style={{ marginBottom: 'var(--space-8)' }}>
          <div
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            style={{
              position: 'relative',
              background: 'var(--review-card-bg)',
              border: `1px solid ${isFocused ? 'var(--review-shell-border-strong)' : 'var(--review-shell-border)'}`,
              borderRadius: 18,
              overflow: 'hidden',
              boxShadow: isFocused ? '0 0 0 1px rgba(88,166,255,0.16)' : 'var(--review-panel-shadow)',
              transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
            }}
          >
            {/* Textarea */}
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="Describe what you want to build..."
              data-gramm="false"
              data-gramm_editor="false"
              data-enable-grammarly="false"
              spellCheck={false}
              rows={isExpanded ? 4 : 2}
              disabled={isCreatingProject}
              style={{
                width: '100%',
                background: 'transparent',
                color: 'var(--text-primary)',
                fontSize: 'var(--text-md)',
                fontFamily: 'var(--font-sans)',
                padding: '18px 18px 14px',
                border: 'none',
                outline: 'none',
                resize: 'none',
                lineHeight: 1.6,
                userSelect: 'text',
              }}
            />

            {selectedFiles.length > 0 && (
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', padding: '0 18px 12px' }}>
                {selectedFiles.map((file, index) => (
                  <div
                    key={`${file.name}-${file.size}-${index}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      maxWidth: 260,
                      padding: '6px 10px',
                      borderRadius: 10,
                      background: 'var(--review-panel-header-bg)',
                      border: '1px solid var(--review-shell-border)',
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {file.name}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>
                        {file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(index)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                      title="Remove file"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.gif,.webp,.txt,.md,.csv,.html,.css,.json,.pdf,.doc,.docx,.xls,.xlsx"
              multiple
              onChange={handleFileSelect}
              style={{ display: 'none' }}
            />

            {/* Bottom bar: buttons matching ChatPanel layout */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 12px',
              borderTop: '1px solid var(--review-shell-divider)',
              background: 'var(--review-panel-header-bg)',
            }}>
              {/* Left side: Attach + Mode selector + Model selector */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                {/* Attach files button */}
                <button
                  type="button"
                  onClick={() => { void handleAttachClick(); }}
                  disabled={isCreatingProject}
                  title="Attach files"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    background: 'transparent',
                    border: 'none',
                    borderRadius: 6,
                    color: 'var(--text-secondary)',
                    cursor: isCreatingProject ? 'not-allowed' : 'pointer',
                    opacity: isCreatingProject ? 0.5 : 1,
                    padding: 0,
                  }}
                >
                  <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                </button>

                {/* Chat Mode Selector (Agent/Plan/Build) */}
                <select
                  value={chatMode}
                  onChange={(e) => {
                    const next = e.target.value as ChatMode;
                    setChatMode(next);
                    try { localStorage.setItem('atlas_chat_mode', next); } catch {}
                  }}
                  disabled={isCreatingProject}
                  title="Chat mode"
                  style={{
                    background: 'var(--review-segment-bg)',
                    border: `1px solid ${
                      chatMode === 'plan' ? 'var(--accent-blue)'
                      : chatMode === 'build' ? 'var(--accent-green)'
                      : 'var(--review-shell-border)'
                    }`,
                    borderRadius: 6,
                    padding: '2px 8px',
                    fontSize: 'var(--text-xs)',
                    color: chatMode === 'plan' ? 'var(--accent-blue)'
                      : chatMode === 'build' ? 'var(--accent-green)'
                      : 'var(--text-primary)',
                    fontFamily: 'var(--font-sans)',
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  <option value="agent">Agent</option>
                  <option value="plan">Plan</option>
                  <option value="build">Build</option>
                </select>

                {/* Model selector */}
                {availableModels.length > 0 && (
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={isLoadingModels}
                    title="Select model"
                    style={{
                      background: 'var(--review-segment-bg)',
                      border: '1px solid var(--review-shell-border)',
                      borderRadius: 6,
                      padding: '2px 8px',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-sans)',
                      cursor: 'pointer',
                      outline: 'none',
                      opacity: isLoadingModels ? 0.5 : 1,
                      maxWidth: 180,
                    }}
                  >
                    {Object.entries(
                      availableModels.reduce<Record<string, ModelOption[]>>((groups, model) => {
                        (groups[model.providerName] ??= []).push(model);
                        return groups;
                      }, {}),
                    ).map(([provider, models]) => (
                      <optgroup key={provider} label={provider}>
                        {models.map((model) => (
                          <option key={model.key} value={model.key}>
                            {model.name}{model.isDefault ? ' (Default)' : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                )}
              </div>

              {/* Right side: Send button */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {/* Send button */}
                <button
                  type="submit"
                  disabled={!prompt.trim() || isCreatingProject}
                  title="Send"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    background: (!prompt.trim() || isCreatingProject) ? 'var(--review-segment-bg)' : 'var(--accent-blue)',
                    border: 'none',
                    color: (!prompt.trim() || isCreatingProject) ? 'var(--text-tertiary)' : 'var(--text-primary)',
                    cursor: (!prompt.trim() || isCreatingProject) ? 'not-allowed' : 'pointer',
                    opacity: (!prompt.trim() || isCreatingProject) ? 0.5 : 1,
                    flexShrink: 0,
                  }}
                >
                  {isCreatingProject ? (
                    <span style={{
                      width: 14,
                      height: 14,
                      border: '2px solid var(--text-tertiary)',
                      borderTopColor: 'var(--text-primary)',
                      borderRadius: '50%',
                      display: 'inline-block',
                      animation: 'spin 0.6s linear infinite',
                    }} />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                  )}
                </button>
              </div>

            </div>
          </div>
        </form>
        )}

        {/* Project Grid — Recent / All tabs */}
        <ProjectTabs
          projects={sortedProjects}
          trustSummaries={trustSummaries}
          loadingSummaries={loadingSummaries}
          loadingSummaryProjectIds={loadingSummaryProjectIds}
          context="build"
          onClickProject={(project) => onSelectProject(project)}
          onSecondaryAction={(project) => ({
            label: 'Open in Builder',
            onClick: () => onSelectProject(project),
          })}
          onRemove={(project, e) => setContextMenu({ x: e.clientX, y: e.clientY, project })}
        />

        {/* Context menu + confirmation dialog for project removal */}
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={[
              ...(contextMenu.project.path ? [{
                label: 'Show in Folder',
                icon: (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  </svg>
                ),
                onClick: async () => {
                  const isTauri = isTauriEnvironment();
                  if (isTauri) {
                    try {
                      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
                      await revealItemInDir(contextMenu.project.path!);
                      return;
                    } catch { /* fall through to backend */ }
                  }
                  try {
                    await projectApi.revealInFolder(contextMenu.project.id);
                  } catch {
                    await navigator.clipboard.writeText(contextMenu.project.path!);
                  }
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
                onClick: () => {
                  setConfirmRemove(contextMenu.project);
                },
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
                ? 'This will stop watching and delete all review history (changesets, branch reviews, AI reviews). The folder on disk won\'t be affected.'
                : 'This will delete the project and all its data.'
            }
            confirmLabel="Remove"
            danger
            onCancel={() => setConfirmRemove(null)}
            onConfirm={async () => {
              const id = confirmRemove.id;
              setConfirmRemove(null);
              try {
                await projectApi.delete(id);
                onRefreshProjects?.();
              } catch (err) {
                console.error('Failed to remove project:', err);
              }
            }}
          />
        )}

        {/* Empty State */}
        {builderProjects.length === 0 && (
          <div style={{ textAlign: 'center', padding: 'var(--space-12) 0' }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: 'var(--review-card-bg)',
              border: '1px solid var(--review-shell-border)',
              boxShadow: 'var(--review-panel-shadow)',
              marginBottom: 'var(--space-6)',
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <h3 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 var(--space-2)' }}>
              No projects yet
            </h3>
            <p style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-tertiary)',
              maxWidth: 400,
              marginLeft: 'auto',
              marginRight: 'auto',
            }}>
              Describe what you want to build above to get started
            </p>
          </div>
        )}

        {/* Template Cards */}
        {templates.length > 0 && (
          <div style={{ marginTop: 'var(--space-8)' }}>
            <p style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase' as const,
              letterSpacing: '0.05em',
              fontWeight: 500,
              marginBottom: 'var(--space-3)',
            }}>
              Start from a template
            </p>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 'var(--space-4)',
            }}>
              {templates.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => onCreateFromTemplate(tpl.id, tpl.name)}
                  disabled={isCreatingProject}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 'var(--space-3)',
                    minHeight: 188,
                    padding: 'var(--space-5)',
                    background: 'var(--review-card-bg)',
                    border: '1px solid var(--review-shell-border)',
                    borderRadius: '18px',
                    boxShadow: 'var(--review-panel-shadow)',
                    cursor: isCreatingProject ? 'not-allowed' : 'pointer',
                    textAlign: 'left',
                    fontFamily: 'var(--font-sans)',
                    transition: 'border-color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast), box-shadow var(--transition-fast)',
                    opacity: isCreatingProject ? 0.6 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!isCreatingProject) {
                      e.currentTarget.style.borderColor = 'var(--review-shell-border-strong)';
                      e.currentTarget.style.background = 'color-mix(in srgb, var(--review-card-bg) 84%, var(--accent-secondary) 16%)';
                      e.currentTarget.style.boxShadow = '0 22px 44px rgba(5, 10, 20, 0.18), inset 0 1px 0 rgba(255,255,255,0.04)';
                      e.currentTarget.style.transform = 'translateY(-1px)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--review-shell-border)';
                    e.currentTarget.style.background = 'var(--review-card-bg)';
                    e.currentTarget.style.boxShadow = 'var(--review-panel-shadow)';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 44,
                    height: 44,
                    borderRadius: 14,
                    background: 'var(--review-panel-bg)',
                    border: '1px solid var(--review-shell-border)',
                    color: 'var(--text-secondary)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
                    flexShrink: 0,
                  }}>
                    <TemplateIcon icon={tpl.icon} />
                  </span>
                  <span style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2 }}>
                    {tpl.name}
                  </span>
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.45, maxWidth: 280 }}>
                    {tpl.description}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderActionButton({
  onClick,
  children,
  primary = false,
}: {
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...(primary
          ? {
              ...getReviewActionButtonStyle({ tone: 'blue' }),
              background: '#35c7ee',
              border: '1px solid rgba(53, 199, 238, 0.72)',
              color: '#04131b',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.22)',
            }
          : getReviewActionButtonStyle({ tone: 'neutral' })),
        gap: 'var(--space-2)',
        padding: '0 var(--space-4)',
        minHeight: 34,
        fontSize: 'var(--text-sm)',
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = primary ? 'rgba(112, 228, 255, 0.92)' : 'var(--review-shell-border-strong)';
        e.currentTarget.style.color = primary ? '#04131b' : 'var(--text-primary)';
        if (primary) {
          e.currentTarget.style.background = '#55d7f6';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = primary ? 'rgba(53, 199, 238, 0.72)' : 'var(--review-shell-border)';
        e.currentTarget.style.color = primary ? '#04131b' : 'var(--text-secondary)';
        if (primary) {
          e.currentTarget.style.background = '#35c7ee';
        }
      }}
    >
      {children}
    </button>
  );
}

export default HomePage;
