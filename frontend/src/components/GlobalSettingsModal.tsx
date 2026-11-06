/**
 * GlobalSettingsModal — Global settings modal overlay
 * Accessible from the gear icon in TrustPipelineShell top bar.
 * Organized into settings sections via left sidebar navigation.
 * Most settings are global (persisted via settingsApi); project-owned review
 * policy editing is surfaced here for convenience.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import toast from '@/lib/toast';
import { describeApiError, providerApi, settingsApi, projectApi, changesetApi, mcpApi, getApiBaseUrl, atlasHostingApi, reviewPolicyApi } from '@/services/api';
import { codegraphApi, type CodegraphStatus } from '@/services/codegraphApi';
import { usePopup } from './shared/PopupProvider';
import GitHubConnect from './GitHubConnect';
import CodeEditor from './CodeEditor';
import { emitAutoReviewSettingChanged } from '@/constants/autoReviewEvents';
import { MCP_AUTO_SELECTED_AGENTS_KEY, parseMcpSelectedAgents } from '@/constants/mcpSettings';
import type {
  McpAgentsResponse,
  McpConfigResponse,
  McpSetupSyncResponse,
  McpStatusResponse,
  ReviewPolicyDocument,
  ReviewPolicyLinterStatus,
  ReviewModelConfig,
  ReviewModelStrategy,
  ReviewModelAdaptiveConfig,
  ReviewModelRolloutConfig,
  VerifyCheckConfig,
  VerifyConfig,
} from '@/services/api';
import type { AIProvider, Project } from '@/types';
import { usePrAutoRefreshSettings } from '@/hooks/usePrAutoRefreshSettings';
import { removeManagedIntegrationsForReset } from '@/hooks/useSetupStatus';
import { getReviewActionButtonStyle } from './review/ReviewChrome';
import { isTauriEnvironment } from '@/utils/tauri';
import { isProviderUsable } from '@/utils/providerStatus';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GlobalSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}

export type SettingsSection =
  | 'review'
  | 'build'
  | 'general'
  | 'mcp'
  | 'github'
  | 'cloud'
  | 'about';

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: React.ReactNode;
}

interface SectionMeta {
  title: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Section SVG Icons (inline, matches existing codebase pattern)
// ---------------------------------------------------------------------------

const iconStyle = { width: 16, height: 16, flexShrink: 0 } as const;

function IconReview() {
  return (
    <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function IconGit() {
  return (
    <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 012 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  );
}

function IconGitHub() {
  return (
    <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 19c-5 1.5-5-2.5-7-3" />
      <path d="M15 22v-4a3.3 3.3 0 00-.9-2.3c3 0 6-1.8 6-8a6 6 0 00-1.7-4.1 5.6 5.6 0 00-.1-4.1s-1.4-.4-4.3 1.6a14.5 14.5 0 00-8 0C3.1-1 1.7-.6 1.7-.6a5.6 5.6 0 00-.1 4.1A6 6 0 000 7.4c0 6.2 3 8 6 8a3.3 3.3 0 00-.9 2.3v4" />
    </svg>
  );
}

function IconVerify() {
  return (
    <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}

function IconGeneral() {
  return (
    <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

function IconAbout() {
  return (
    <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function IconBuild() {
  return (
    <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function IconCloud() {
  return (
    <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z" />
    </svg>
  );
}

function IconMcp() {
  return (
    <svg style={iconStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 7a4 4 0 118 0v3" />
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M9 14h6M9 17h4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Navigation items
// ---------------------------------------------------------------------------

import { ENABLE_BUILDER } from '@/featureFlags';
import { applyFontScale } from '@/utils/uiScale';

const ALL_NAV_ITEMS: NavItem[] = [
  { id: 'review', label: 'Review', icon: <IconReview /> },
  { id: 'build', label: 'Build', icon: <IconBuild /> },
  { id: 'mcp', label: 'MCP', icon: <IconMcp /> },
  { id: 'github', label: 'GitHub', icon: <IconGitHub /> },
  { id: 'cloud', label: 'Cloud', icon: <IconCloud /> },
  { id: 'general', label: 'General', icon: <IconGeneral /> },
  { id: 'about', label: 'About', icon: <IconAbout /> },
];

const BUILDER_ONLY_SECTIONS = new Set(['build', 'cloud']);

const NAV_ITEMS = ENABLE_BUILDER
  ? ALL_NAV_ITEMS
  : ALL_NAV_ITEMS.filter(item => !BUILDER_ONLY_SECTIONS.has(item.id));

const DESKTOP_DATABASE_DISPLAY_PATH = '~/Library/Application Support/com.atlasengine.desktop/atlas.db';

const PROJECT_SECTION_IDS = new Set<SettingsSection>(['review', 'build', 'mcp', 'github', 'cloud']);
const APP_SECTION_IDS = new Set<SettingsSection>(['general', 'about']);

const SECTION_META: Record<SettingsSection, SectionMeta> = {
  review: {
    title: 'Review',
    description: 'Review provider, policy file, git defaults, and auto-review rules',
  },
  build: {
    title: 'Build',
    description: 'Build provider and verification settings',
  },
  mcp: {
    title: 'MCP',
    description: 'MCP server status and connected agents',
  },
  github: {
    title: 'GitHub',
    description: 'GitHub account, repository, and publishing configuration',
  },
  cloud: {
    title: 'Cloud',
    description: 'Deployment credentials and publish guardrails',
  },
  general: {
    title: 'General',
    description: 'App defaults, display, data, and integration reset settings',
  },
  about: {
    title: 'About',
    description: 'Version, storage, and diagnostic information',
  },
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

function GlobalSettingsModal({ isOpen, onClose, initialSection }: GlobalSettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('review');

  useEffect(() => {
    if (isOpen && initialSection) {
      setActiveSection(initialSection);
    }
  }, [isOpen, initialSection]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const activeMeta = SECTION_META[activeSection];
  const projectNavItems = NAV_ITEMS.filter((item) => PROJECT_SECTION_IDS.has(item.id));
  const appNavItems = NAV_ITEMS.filter((item) => APP_SECTION_IDS.has(item.id));

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        display: 'flex',
        background: 'var(--review-shell-bg)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: '100%',
          background: 'var(--review-shell-bg)',
          overflow: 'hidden',
        }}
      >
        {/* Left sidebar */}
        <div
          style={{
            width: 180,
            minWidth: 180,
            background: 'var(--review-shell-bg)',
            borderRight: '1px solid var(--review-shell-divider)',
            display: 'flex',
            flexDirection: 'column',
            padding: '76px var(--space-2) var(--space-4)',
          }}
        >
          <nav data-testid="settings-sidebar-nav" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            <SidebarNavGroup
              label="Project"
              items={projectNavItems}
              activeSection={activeSection}
              onSelect={setActiveSection}
            />
            <SidebarNavGroup
              label="App"
              items={appNavItems}
              activeSection={activeSection}
              onSelect={setActiveSection}
            />
          </nav>
        </div>

        {/* Right content area */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: 'var(--review-shell-bg)',
          }}
        >
          {/* Top chrome */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              padding: '0 var(--space-4) 0 var(--space-6)',
              borderBottom: '1px solid var(--review-shell-divider)',
              minHeight: 68,
              background: 'var(--review-shell-bg)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                minWidth: 0,
                fontSize: 'var(--text-lg)',
                fontWeight: 800,
                color: 'var(--text-primary)',
              }}
            >
              Settings
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexShrink: 0 }}>
              <button
                type="button"
                onClick={onClose}
                title="Close settings"
                style={{
                  ...getReviewActionButtonStyle({ tone: 'neutral' }),
                  height: 30,
                  minHeight: 30,
                  padding: '0 14px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 700,
                }}
              >
                Done
              </button>
            </div>
          </div>

          <div
            style={{
              padding: 'var(--space-5) var(--space-6) var(--space-3)',
              borderBottom: '1px solid var(--review-shell-divider)',
              background: 'var(--review-shell-bg)',
            }}
          >
            <h1
              className="review-shell-title"
              style={{
                margin: 0,
                fontSize: 'var(--text-xl)',
                lineHeight: 1.15,
                fontWeight: 800,
                color: 'var(--text-primary)',
              }}
            >
              {activeMeta.title}
            </h1>
            <div style={{ marginTop: 6, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', fontWeight: 600 }}>
              {activeMeta.description}
            </div>
          </div>

          {/* Scrollable section content */}
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '0 var(--space-6) var(--space-8)',
              background: 'var(--review-shell-bg)',
            }}
          >
            <div style={{ maxWidth: 1120 }}>
              <SectionContent section={activeSection} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar nav item
// ---------------------------------------------------------------------------

function SidebarNavGroup({
  label,
  items,
  activeSection,
  onSelect,
}: {
  label: string;
  items: NavItem[];
  activeSection: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'grid', gap: 7 }}>
      <div
        style={{
          padding: '0 10px',
          fontSize: 'var(--text-xs)',
          fontWeight: 800,
          color: 'var(--text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {label}
      </div>
      <div style={{ display: 'grid', gap: 2 }}>
        {items.map((item) => (
          <SidebarNavItem
            key={item.id}
            item={item}
            isActive={activeSection === item.id}
            onClick={() => onSelect(item.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SidebarNavItem({
  item,
  isActive,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        padding: '8px 10px',
        borderRadius: 'var(--radius-md)',
        background: isActive ? 'var(--review-segment-active-bg)' : 'transparent',
        border: '1px solid transparent',
        borderLeft: isActive ? '2px solid var(--accent-blue)' : '2px solid transparent',
        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 'var(--text-sm)',
        fontFamily: 'var(--font-sans)',
        fontWeight: isActive ? 800 : 700,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'var(--review-chip-neutral-bg)';
          e.currentTarget.style.color = 'var(--text-primary)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--text-secondary)';
        }
      }}
    >
      {item.icon}
      {item.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Section content router — placeholder for all 7 sections
// ---------------------------------------------------------------------------

function SectionContent({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'review':
      return <ReviewSection />;
    case 'build':
      return <BuildSection />;
    case 'general':
      return <GeneralSection />;
    case 'mcp':
      return <McpSection />;
    case 'github':
      return <GitHubSection />;
    case 'cloud':
      return <CloudSection />;
    case 'about':
      return <AboutSection />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  background: 'var(--review-card-bg)',
  border: '1px solid var(--review-shell-border)',
  borderRadius: 'var(--radius-lg)',
  padding: 'var(--space-4)',
  marginBottom: 'var(--space-4)',
  boxShadow: 'none',
};

const subsectionLabelStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  fontWeight: 700,
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 'var(--space-3)',
};

const btnBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  padding: 'var(--space-2) var(--space-3)',
  minHeight: 30,
  borderRadius: 'var(--radius-md)',
  border: 'none',
  fontSize: 'var(--text-xs)',
  fontFamily: 'var(--font-sans)',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background var(--transition-fast), color var(--transition-fast)',
};

const btnPrimary: React.CSSProperties = {
  ...btnBase,
  ...getReviewActionButtonStyle({ tone: 'blue', active: true }),
  padding: '0 var(--space-3)',
};

const btnSecondary: React.CSSProperties = {
  ...btnBase,
  ...getReviewActionButtonStyle({ tone: 'neutral' }),
  padding: '0 var(--space-3)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 'var(--space-2) var(--space-3)',
  background: 'var(--review-code-bg)',
  border: '1px solid var(--review-shell-border)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-mono)',
  outline: 'none',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: 'var(--font-sans)',
  cursor: 'pointer',
  appearance: 'auto' as React.CSSProperties['appearance'],
};

// ---------------------------------------------------------------------------
// Shared Provider Selector — used by both Review and Build sections
// ---------------------------------------------------------------------------

interface ProviderSelectorProps {
  /** 'review' or 'build' — determines context-active storage and filtering */
  context: 'review' | 'build';
  /** If true, only show tool-capable providers. Build uses this. */
  toolCapableOnly?: boolean;
}

function ProviderSelector({ context, toolCapableOnly = false }: ProviderSelectorProps) {
  // Provider state
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [otherProvidersExpanded, setOtherProvidersExpanded] = useState(false);
  const [providerConfigs, setProviderConfigs] = useState<Array<{
    type: string;
    label: string;
    models: Array<{ id: string; label: string; toolSupport?: boolean; reviewCapable?: boolean }>;
    defaultModel: string;
    byokEligible?: boolean;
    toolSupport?: boolean;
  }>>([]);

  // Context-active provider (the one selected for this context)
  const [contextActiveId, setContextActiveId] = useState<string | null>(null);

  // BYOK form state
  const [byokType, setByokType] = useState('anthropic');
  const [byokApiKey, setByokApiKey] = useState('');
  const [byokModel, setByokModel] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; latencyMs: number; error?: string } | null>(null);
  const [manualApiKeyExpanded, setManualApiKeyExpanded] = useState(false);

  // Testing individual providers (by provider id)
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);

  // Load on mount
  useEffect(() => {
    loadProviders();
    loadConfigs();
    loadContextActive();
  }, [context]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadContextActive = async () => {
    try {
      const result = await providerApi.getContextActive(context);
      setContextActiveId(result.data?.providerId || null);
    } catch { /* silent — falls back to global active */ }
  };

  const loadProviders = async () => {
    setLoading(true);
    try {
      const result = await providerApi.list();
      setProviders(result.providers);
    } catch {
      // Silent
    } finally {
      setLoading(false);
    }
  };

  const loadConfigs = async () => {
    try {
      const result = await providerApi.getConfigs();
      setProviderConfigs(result.configs);
    } catch {
      // Silent
    }
  };

  const handleScan = useCallback(async () => {
    setIsScanning(true);
    try {
      const result = await providerApi.scan();
      setProviders(result.providers);
      try {
        const contextActive = await providerApi.getContextActive(context);
        setContextActiveId(contextActive.data?.providerId || result.activeProvider?.id || null);
      } catch {
        setContextActiveId(result.activeProvider?.id || null);
      }
      window.dispatchEvent(new Event(`${context}-provider-changed`));
      window.dispatchEvent(new Event('provider-changed'));
      if (result.providers.length > 0) {
        toast.success(`Found ${result.providers.length} provider(s)`);
      } else {
        toast('No AI tools detected. Add an API key manually.', { icon: 'i' });
      }
    } catch {
      toast.error('Scan failed');
    } finally {
      setIsScanning(false);
    }
  }, [context, toolCapableOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTestProvider = useCallback(async (provider: AIProvider) => {
    setTestingProviderId(provider.id);
    try {
      await providerApi.validateAll();
      const updated = await providerApi.list();
      setProviders(updated.providers);
      const refreshed = updated.providers.find(p => p.id === provider.id);
      if (refreshed?.status === 'connected') {
        toast.success(`${refreshed.label}: Connected`);
      } else if (refreshed?.status === 'unchecked') {
        // Keychain-backed CLI install where subprocess can't read auth state.
        // Not a failure — the binary and post-login artifacts both exist;
        // first review will surface any real auth error from the CLI itself.
        toast.success(`${refreshed.label}: CLI detected — auth will verify on first use`);
      } else {
        toast.error(`${refreshed?.label ?? provider.label}: ${refreshed?.error ?? 'Connection failed'}`);
      }
    } catch {
      toast.error('Test failed');
    } finally {
      setTestingProviderId(null);
    }
  }, []);

  const handleUseProvider = useCallback(async (providerId: string) => {
    try {
      // Also set as global active
      const result = await providerApi.setActive(providerId);
      // Set as context-active for this context
      const provider = providers.find(p => p.id === providerId) || result.provider;
      await providerApi.setContextActive(context, providerId, provider?.model);
      setContextActiveId(providerId);
      setProviders(prev => prev.map(p => ({ ...p, isActive: p.id === providerId })));
      toast.success(`${context === 'review' ? 'Review' : 'Build'} provider: ${result.provider.label}`);
      window.dispatchEvent(new Event(`${context}-provider-changed`));
      window.dispatchEvent(new Event('provider-changed'));
    } catch {
      toast.error('Failed to set provider');
    }
  }, [context, providers]);

  const handleRemove = useCallback(async (providerId: string) => {
    try {
      await providerApi.remove(providerId);
      const updated = await providerApi.list();
      setProviders(updated.providers);
      toast.success('Provider removed');
    } catch {
      toast.error('Failed to remove provider');
    }
  }, []);

  const handleTestBYOK = useCallback(async () => {
    if (!byokApiKey.trim()) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await providerApi.testConnection(byokType, byokApiKey.trim());
      setTestResult(result);
    } catch {
      setTestResult({ success: false, latencyMs: 0, error: 'Connection test failed' });
    } finally {
      setIsTesting(false);
    }
  }, [byokType, byokApiKey]);

  const handleAddBYOK = useCallback(async () => {
    if (!byokApiKey.trim()) {
      toast.error('API key is required');
      return;
    }
    setIsSaving(true);
    try {
      const result = await providerApi.addBYOK(byokType, byokApiKey.trim(), byokModel || undefined);
      if (result.provider.status === 'connected') {
        toast.success(`${result.provider.label} connected`);
      } else {
        toast.error(result.provider.error || 'Connection failed');
      }
      const updated = await providerApi.list();
      setProviders(updated.providers);
      try {
        const contextActive = await providerApi.getContextActive(context);
        setContextActiveId(contextActive.data?.providerId || null);
      } catch { /* silent */ }
      setByokApiKey('');
      setByokModel('');
      setTestResult(null);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to add provider';
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  }, [byokType, byokApiKey, byokModel]);

  const handleUpdateModel = useCallback(async (providerId: string, model: string) => {
    try {
      const targetProvider = providers.find((provider) => provider.id === providerId);
      if (targetProvider?.type === 'opencode') {
        toast('Change the OpenCode model in OpenCode itself using /models, then re-scan Atlas.', { icon: 'i' });
        return;
      }
      await providerApi.updateModel(providerId, model);
      const updated = await providerApi.list();
      setProviders(updated.providers);
      // Update context-active model if this is the context-active provider
      if (providerId === contextActiveId) {
        await providerApi.setContextActive(context, providerId, model);
        window.dispatchEvent(new Event(`${context}-provider-changed`));
      }
    } catch {
      toast.error('Failed to update model');
    }
  }, [context, contextActiveId, providers]);

  // -- Status helpers --

  const statusColor = (status: AIProvider['status']): string => {
    switch (status) {
      case 'connected': return 'var(--status-success, #22c55e)';
      case 'error': return 'var(--status-error, #ef4444)';
      case 'expired':
      case 'needs_key': return 'var(--status-warning, #eab308)';
      default: return 'var(--text-tertiary)';
    }
  };

  const statusLabel = (status: AIProvider['status']): string => {
    switch (status) {
      case 'connected': return 'Connected';
      case 'error': return 'Error';
      case 'expired': return 'Expired';
      case 'needs_key': return 'Needs key';
      case 'unchecked': return 'Unchecked';
      default: return status;
    }
  };

  const formatRelativeTime = (dateStr: string | null): string => {
    if (!dateStr) return 'Never';
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  // Filter providers for tool capability when needed (Build tab)
  const filteredProviders = toolCapableOnly
    ? providers.filter(p => {
        // CLI providers (claude, codex, gemini) all support tools
        if (p.source === 'cli_detected' && p.type !== 'opencode') return true;
        // BYOK providers (anthropic, openai, google) all support tools via API
        if (p.source === 'byok') return true;
        // OpenCode: shown (but models are filtered by getOpenCodeModels)
        if (p.type === 'opencode') return true;
        return false;
      })
    : providers;

  // Split into context-active and others
  const effectiveActiveId = contextActiveId || filteredProviders.find(p => p.isActive)?.id || null;
  const activeProvider = effectiveActiveId ? filteredProviders.find(p => p.id === effectiveActiveId) : null;
  const otherProviders = filteredProviders.filter(p => p.id !== effectiveActiveId);

  useEffect(() => {
    if (otherProviders.length === 0) {
      setOtherProvidersExpanded(false);
    }
  }, [otherProviders.length]);

  useEffect(() => {
    if (!activeProvider && otherProviders.length > 0) {
      setOtherProvidersExpanded(true);
    }
  }, [activeProvider, otherProviders.length]);

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {[1, 2, 3].map(i => (
          <div key={i} style={{ ...cardStyle, height: 60, opacity: 0.5 }} />
        ))}
      </div>
    );
  }

  /** Renders a single provider card */
  const renderProviderCard = (provider: AIProvider, isContextActive: boolean) => (
    <div key={provider.id} style={{
      ...cardStyle,
      ...(isContextActive ? { border: '1px solid rgba(34,197,94,0.35)', background: 'rgba(34,197,94,0.06)' } : {}),
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)', flex: 1 }}>
          <div style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: statusColor(provider.status),
            marginTop: 5,
            flexShrink: 0,
          }} />
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}>
              {provider.label}
              {isContextActive && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--status-success, #22c55e)', fontWeight: 400, marginLeft: 8 }}>
                  Active for {context}
                </span>
              )}
            </div>
            <div style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--text-tertiary)',
              marginTop: 2,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
            }}>
              <span>{provider.source === 'cli_detected' ? 'CLI detected' : 'API Key (BYOK)'}</span>
              <span>&middot;</span>
              <span>{provider.model}</span>
              <span>&middot;</span>
              <span style={{ color: statusColor(provider.status) }}>{statusLabel(provider.status)}</span>
              {provider.lastCheckedAt && (
                <>
                  <span>&middot;</span>
                  <span>Last checked: {formatRelativeTime(provider.lastCheckedAt)}</span>
                </>
              )}
            </div>
            {provider.error && (
              <div style={{
                fontSize: 'var(--text-xs)',
                color: provider.status === 'needs_key' ? 'var(--status-warning, #eab308)' : 'var(--status-error, #ef4444)',
                marginTop: 4,
              }}>
                {provider.error}
              </div>
            )}
            {isProviderUsable(provider) && provider.type !== 'opencode' && providerConfigs.length > 0 && (
              <div style={{ marginTop: 'var(--space-2)', maxWidth: 300 }}>
                <select
                  value={provider.model}
                  onChange={(e) => handleUpdateModel(provider.id, e.target.value)}
                  style={{ ...selectStyle, fontSize: 'var(--text-xs)', padding: '3px var(--space-2)' }}
                >
                  {(providerConfigs.find(c => c.type === provider.type)?.models || [])
                  .filter((m: { toolSupport?: boolean; reviewCapable?: boolean }) => (!toolCapableOnly || m.toolSupport !== false) && (toolCapableOnly || m.reviewCapable !== false))
                  .map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
            )}
            {provider.type === 'opencode' && (
              <div style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--text-tertiary)',
                marginTop: 'var(--space-2)',
              }}>
                Atlas reads the active OpenCode model from your local OpenCode config. Change it in OpenCode with <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--review-code-bg)', border: '1px solid var(--review-shell-border)', borderRadius: 6, padding: '1px 6px' }}>/models</code>, then re-scan Atlas.
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0, marginLeft: 'var(--space-3)' }}>
          <button
            type="button"
            onClick={() => handleTestProvider(provider)}
            disabled={testingProviderId === provider.id}
            style={{ ...btnSecondary, opacity: testingProviderId === provider.id ? 0.6 : 1 }}
          >
            {testingProviderId === provider.id ? 'Testing...' : 'Test'}
          </button>
          {!isContextActive && isProviderUsable(provider) && (
            <button
              type="button"
              onClick={() => handleUseProvider(provider.id)}
              style={btnPrimary}
            >
              Use
            </button>
          )}
          {provider.source === 'byok' && (
            <button
              type="button"
              onClick={() => handleRemove(provider.id)}
              title="Remove provider"
              style={{
                ...btnBase,
                background: 'transparent',
                color: 'var(--text-tertiary)',
                padding: 'var(--space-1)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--status-error, #ef4444)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
            >
              <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div>
      {/* ---- Active Provider for this context ---- */}
      <div style={subsectionLabelStyle}>
        {context === 'review' ? 'Review' : 'Build'} Provider
      </div>
      {activeProvider ? (
        renderProviderCard(activeProvider, true)
      ) : (
        <div style={{
          ...cardStyle,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-6)',
        }}>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--status-warning, #eab308)' }}>
            No provider selected. Click Scan to detect tools, or add an API key below.
          </div>
          <button
            type="button"
            onClick={handleScan}
            disabled={isScanning}
            style={{ ...btnPrimary, opacity: isScanning ? 0.6 : 1 }}
          >
            <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {isScanning ? 'Scanning...' : 'Scan for tools'}
          </button>
        </div>
      )}

      {/* ---- Other Providers ---- */}
      {otherProviders.length > 0 && (
        <div
          style={{
            ...cardStyle,
            padding: 0,
            overflow: 'hidden',
            marginBottom: 'var(--space-5)',
          }}
        >
          <button
            type="button"
            onClick={() => setOtherProvidersExpanded((current) => !current)}
            aria-expanded={otherProvidersExpanded}
            style={{
              ...btnBase,
              width: '100%',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: 'var(--space-4)',
              background: 'transparent',
              color: 'var(--text-primary)',
            }}
          >
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {activeProvider ? 'Other Providers' : 'Detected Providers'}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 22,
                    height: 22,
                    padding: '0 8px',
                    borderRadius: 999,
                    background: 'rgba(255,255,255,0.06)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-secondary)',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 600,
                  }}
                >
                  {otherProviders.length}
                </span>
              </span>
              <span
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-tertiary)',
                  textAlign: 'left',
                }}
              >
                {activeProvider
                  ? `Available alternatives you can switch to for ${context}.`
                  : `Detected providers that still need setup before they can be used for ${context}.`}
              </span>
            </span>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                borderRadius: '50%',
                border: '1px solid var(--border-default)',
                background: 'rgba(255,255,255,0.04)',
                color: 'var(--text-tertiary)',
                flexShrink: 0,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                style={{
                  transform: otherProvidersExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform var(--transition-fast)',
                }}
              >
                <path
                  d="M4 6L8 10L12 6"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
          {otherProvidersExpanded && (
            <div
              style={{
                borderTop: '1px solid var(--border-default)',
                padding: 'var(--space-3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              {otherProviders.map((provider) => renderProviderCard(provider, false))}
            </div>
          )}
        </div>
      )}

      {/* Re-scan button */}
      {filteredProviders.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-5)' }}>
          <button
            type="button"
            onClick={handleScan}
            disabled={isScanning}
            style={{ ...btnSecondary, opacity: isScanning ? 0.6 : 1 }}
          >
            <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {isScanning ? 'Scanning...' : 'Re-scan'}
          </button>
        </div>
      )}

      {/* ---- Manual API Key (BYOK) ---- */}
      <div
        style={{
          ...cardStyle,
          padding: 0,
          overflow: 'hidden',
          marginBottom: 'var(--space-5)',
        }}
      >
        <button
          type="button"
          onClick={() => setManualApiKeyExpanded((current) => !current)}
          aria-expanded={manualApiKeyExpanded}
          style={{
            ...btnBase,
            width: '100%',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: 'var(--space-4)',
            background: 'transparent',
            color: 'var(--text-primary)',
          }}
        >
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
            <span
              style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-secondary)',
              }}
            >
              Manual API Key (BYOK)
            </span>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', textAlign: 'left' }}>
              Use your own provider keys instead of CLI auto-detection.
            </span>
          </span>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: '1px solid var(--border-default)',
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-tertiary)',
              flexShrink: 0,
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              style={{
                transform: manualApiKeyExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform var(--transition-fast)',
              }}
            >
              <path
                d="M4 6L8 10L12 6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>

        {manualApiKeyExpanded && (
          <div
            style={{
              borderTop: '1px solid var(--border-default)',
              padding: 'var(--space-4)',
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            {/* Provider type */}
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>
                Provider
              </label>
              <select
                value={byokType}
                onChange={(e) => { setByokType(e.target.value); setByokModel(''); setTestResult(null); }}
                style={{ ...selectStyle, maxWidth: 240 }}
              >
                {providerConfigs.filter(c => c.byokEligible !== false).map((config) => (
                  <option key={config.type} value={config.type}>{config.label}</option>
                ))}
              </select>
            </div>

            {/* API Key */}
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>
                {byokType === 'anthropic' ? 'Anthropic API Key' : byokType === 'openai' ? 'OpenAI API Key' : byokType === 'google' ? 'Google API Key' : 'API Key'}
              </label>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <input
                  type="password"
                  value={byokApiKey}
                  onChange={(e) => { setByokApiKey(e.target.value); setTestResult(null); }}
                  placeholder={byokType === 'anthropic' ? 'sk-ant-...' : byokType === 'google' ? 'AIza...' : 'sk-...'}
                  style={inputStyle}
                />
                {byokApiKey && (
                  <button
                    type="button"
                    onClick={() => { setByokApiKey(''); setTestResult(null); }}
                    style={{ ...btnBase, background: 'transparent', color: 'var(--text-tertiary)', padding: 'var(--space-1)' }}
                    title="Clear"
                  >
                    &times;
                  </button>
                )}
              </div>
            </div>

            {/* Model selector */}
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>
                Model
              </label>
              <select
                value={byokModel || providerConfigs.find(c => c.type === byokType)?.defaultModel || ''}
                onChange={(e) => setByokModel(e.target.value)}
                style={{ ...selectStyle, maxWidth: 340 }}
              >
                {providerConfigs.find(c => c.type === byokType)?.models
                  .filter((model: any) => (!toolCapableOnly || model.toolSupport !== false) && (toolCapableOnly || model.reviewCapable !== false))
                  .map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
              </select>
            </div>

            {/* Test result */}
            {testResult && (
              <div style={{
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-md)',
                marginBottom: 'var(--space-3)',
                fontSize: 'var(--text-xs)',
                background: testResult.success ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                border: testResult.success ? '1px solid rgba(34,197,94,0.3)' : '1px solid rgba(239,68,68,0.3)',
                color: testResult.success ? 'var(--status-success, #22c55e)' : 'var(--status-error, #ef4444)',
              }}>
                {testResult.success ? `Connected (${testResult.latencyMs}ms)` : `Failed: ${testResult.error}`}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <button
                type="button"
                onClick={handleTestBYOK}
                disabled={isTesting || !byokApiKey.trim()}
                style={{ ...btnSecondary, opacity: (isTesting || !byokApiKey.trim()) ? 0.5 : 1 }}
              >
                {isTesting ? 'Testing...' : 'Test Connection'}
              </button>
              <button
                type="button"
                onClick={handleAddBYOK}
                disabled={isSaving || !byokApiKey.trim()}
                style={{ ...btnPrimary, opacity: (isSaving || !byokApiKey.trim()) ? 0.5 : 1 }}
              >
                {isSaving ? 'Saving...' : 'Save Key'}
              </button>
            </div>

            {/* Privacy notice */}
            <div style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--text-tertiary)',
              marginTop: 'var(--space-3)',
              lineHeight: 1.5,
            }}>
              Keys are stored locally (encrypted) and never sent to AtlasEngine servers.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build Section
// ---------------------------------------------------------------------------

function formatTimeout(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? (s > 0 ? `${m}m ${s}s` : `${m}m`) : `${s}s`;
}

function BuildSection() {
  const [activeTab, setActiveTab] = useState<BuildSettingsTab>('ai_provider');
  const [cliTimeout, setCliTimeout] = useState(180);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    settingsApi.get('build_cli_timeout').then((res) => {
      if (res.value != null) {
        const parsed = parseInt(res.value, 10);
        if (Number.isFinite(parsed) && parsed >= 30 && parsed <= 600) {
          setCliTimeout(parsed);
        }
      }
    }).catch(() => {});
  }, []);

  const handleTimeoutChange = useCallback((value: number) => {
    const clamped = Math.min(600, Math.max(30, Math.round(value)));
    setCliTimeout(clamped);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      settingsApi.set('build_cli_timeout', String(clamped)).catch(() => {
        toast.error('Failed to save timeout setting');
      });
    }, 500);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <SettingsSubtabBar
        tabs={BUILD_SETTINGS_TABS}
        activeTab={activeTab}
        onChange={(tab) => setActiveTab(tab as BuildSettingsTab)}
      />

      <div>
        {activeTab === 'ai_provider' && (
          <div>
            <ProviderSelector context="build" toolCapableOnly />

            <div style={{ ...subsectionLabelStyle, marginTop: 'var(--space-4)' }}>
              Build Chat Settings
            </div>
            <div style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--space-2)' }}>
                <label style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
                  CLI Timeout
                </label>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', minWidth: 56, textAlign: 'right' }}>
                  {formatTimeout(cliTimeout)}
                </span>
              </div>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', margin: '0 0 var(--space-3) 0' }}>
                Maximum time to wait for AI provider response before timing out.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>30s</span>
                <input
                  type="range"
                  min={30}
                  max={600}
                  step={10}
                  value={cliTimeout}
                  onChange={(e) => handleTimeoutChange(parseInt(e.target.value, 10))}
                  style={{ flex: 1, accentColor: 'var(--accent-blue)' }}
                />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>10m</span>
              </div>
            </div>
          </div>
        )}
        {activeTab === 'verify' && <VerifySection />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review Section
// ---------------------------------------------------------------------------

const REVIEW_DEPTH_OPTIONS = [
  { value: 'quick', label: 'Quick', description: 'Fast, surface-level review' },
  { value: 'balanced', label: 'Balanced', description: 'Default, good coverage' },
  { value: 'deep', label: 'Deep', description: 'Thorough, slower, more tokens' },
];

const EXECUTION_MODE_METADATA: Record<string, { label: string; description: string }> = {
  'api': { label: 'API', description: 'Direct API call using your BYOK key. Fastest and most reliable.' },
  'cli-agentic': { label: 'CLI Agentic', description: 'Multi-turn CLI mode — CLI Agent explores the repo for deeper reviews.' },
  'cli-agent': { label: 'CLI Agent', description: 'Single-turn CLI agent with structured envelope prompt.' },
  'cli-pipe': { label: 'CLI Pipe', description: 'Simple CLI pipe mode using your Claude/Codex/Gemini subscription.' },
};

const ALL_EXECUTION_MODES = ['api', 'cli-agentic', 'cli-agent', 'cli-pipe'] as const;

function computeDefaultModeOrder(providerSource: string): string[] {
  if (providerSource === 'byok') {
    return ['api', 'cli-agentic', 'cli-agent', 'cli-pipe'];
  }
  // cli_detected
  return ['cli-agentic', 'cli-agent', 'api', 'cli-pipe'];
}

function computeAvailableModes(providerSource: string, providerType: string): Set<string> {
  const available = new Set<string>();
  if (providerSource === 'byok') available.add('api');
  const supportsCli = providerType === 'anthropic' || providerType === 'openai' || providerType === 'google' || providerType === 'opencode';
  const supportsCliAgentic = supportsCli;
  if (supportsCli && providerSource === 'cli_detected') {
    if (supportsCliAgentic) available.add('cli-agentic');
    available.add('cli-agent');
    available.add('cli-pipe');
  }
  // If byok + CLI-capable type, both API and CLI modes are available
  if (providerSource === 'byok' && supportsCli) {
    if (supportsCliAgentic) available.add('cli-agentic');
    available.add('cli-agent');
    available.add('cli-pipe');
  }
  return available;
}

const RISK_THRESHOLD_OPTIONS = [
  { value: 'none', label: 'None', description: 'Never block (just warn)' },
  { value: 'high', label: 'High', description: 'Block on HIGH risk only' },
  { value: 'medium', label: 'Medium', description: 'Block on MEDIUM and above' },
];

const DEFAULT_FOCUS_AREAS: { key: string; label: string; defaultOn: boolean }[] = [
  { key: 'security', label: 'Security issues', defaultOn: true },
  { key: 'performance', label: 'Performance concerns', defaultOn: true },
  { key: 'logic', label: 'Logic errors', defaultOn: true },
  { key: 'best_practices', label: 'Best practices', defaultOn: true },
  { key: 'style', label: 'Style / formatting', defaultOn: false },
  { key: 'documentation', label: 'Documentation gaps', defaultOn: false },
];

const DEFAULT_IGNORE_PATTERNS = [
  'package-lock.json',
  '*.min.js',
  'dist/**',
  '.atlas/changesets.json',
];

const REVIEW_IGNORE_PATTERN_PRESETS: Array<{
  id: string;
  label: string;
  patterns: string[];
}> = [
  {
    id: 'javascript_typescript',
    label: 'JavaScript / TypeScript',
    patterns: [
      ...DEFAULT_IGNORE_PATTERNS,
      'pnpm-lock.yaml',
      'yarn.lock',
      'coverage/**',
      '.next/**',
      'build/**',
      '*.map',
    ],
  },
  {
    id: 'python',
    label: 'Python',
    patterns: [
      '.atlas/changesets.json',
      '__pycache__/**',
      '*.pyc',
      '.pytest_cache/**',
      '.mypy_cache/**',
      '.ruff_cache/**',
      '.venv/**',
      'venv/**',
      'dist/**',
      'build/**',
    ],
  },
  {
    id: 'java_kotlin',
    label: 'Java / Kotlin',
    patterns: [
      '.atlas/changesets.json',
      '.gradle/**',
      'build/**',
      'target/**',
      '.mvn/**',
      '*.class',
      '*.jar',
      '*.war',
    ],
  },
  {
    id: 'go',
    label: 'Go',
    patterns: [
      '.atlas/changesets.json',
      'bin/**',
      'dist/**',
      'coverage.out',
      '*.test',
      'vendor/**',
    ],
  },
  {
    id: 'rust',
    label: 'Rust',
    patterns: [
      '.atlas/changesets.json',
      'target/**',
      'Cargo.lock',
      '*.rlib',
      '*.rmeta',
    ],
  },
  {
    id: 'unity_csharp',
    label: 'Unity / C#',
    patterns: [
      '.atlas/changesets.json',
      'Library/**',
      'Temp/**',
      'Logs/**',
      'Obj/**',
      'Build/**',
      'Builds/**',
      'UserSettings/**',
      '*.csproj',
      '*.sln',
      '*.userprefs',
    ],
  },
];

const REVIEW_MODEL_STRATEGY_OPTIONS: Array<{
  value: ReviewModelStrategy;
  label: string;
  description: string;
  experimental?: boolean;
}> = [
  {
    value: 'smart',
    label: 'Balanced',
    description: 'Uses the selected provider with Atlas defaults for the normal review path.',
  },
  {
    value: 'performance',
    label: 'Performance',
    description: 'Optimizes review speed and cost while preserving review quality.',
    experimental: true,
  },
  {
    value: 'adaptive',
    label: 'Cost-aware',
    description: 'Uses cheaper review models for small, low-risk changes and stronger models for risky ones.',
  },
  {
    value: 'max_quality',
    label: 'Maximum quality',
    description: "Always uses your provider's strongest model for the deepest analysis.",
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Select the exact model used for reviews.',
  },
];

const DEFAULT_REVIEW_MODEL_ADAPTIVE: ReviewModelAdaptiveConfig = {
  fastPathMaxFiles: 12,
  fastPathMaxDiffChars: 45000,
  preferQualityOnHighRisk: true,
};

const DEFAULT_REVIEW_MODEL_ROLLOUT: ReviewModelRolloutConfig = {
  mode: 'on',
  canaryPercent: 25,
  projectAllowlist: [],
};

function normalizeVisibleReviewModelStrategy(strategy: ReviewModelStrategy): ReviewModelStrategy {
  return strategy === 'latency_first' ? 'smart' : strategy;
}

type BuildSettingsTab = 'ai_provider' | 'verify';

const BUILD_SETTINGS_TABS: Array<{
  id: BuildSettingsTab;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: 'ai_provider', label: 'AI Provider', icon: <IconReview /> },
  { id: 'verify', label: 'Verify', icon: <IconVerify /> },
];

type ReviewSettingsTab = 'ai_provider' | 'policy' | 'git';

const REVIEW_SETTINGS_TABS: Array<{
  id: ReviewSettingsTab;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: 'ai_provider', label: 'AI Provider', icon: <IconReview /> },
  { id: 'policy', label: 'Policy File', icon: <IconReview /> },
  { id: 'git', label: 'Git', icon: <IconGit /> },
];

type PolicyInfoSection = 'defaults' | 'prompt' | 'linters' | 'paths' | null;

const SECTION_INFO: Record<Exclude<PolicyInfoSection, null>, Array<{ label: string; description: string }>> = {
  defaults: [
    { label: 'requireEvidence', description: 'Only report findings when Atlas has concrete supporting evidence, not weak suspicions.' },
    { label: 'allowPraise', description: 'Allow praise-only comments instead of limiting output to actionable issues.' },
    { label: 'maxRecommendations', description: 'Cap the number of recommendation-level findings Atlas reports. Leave empty for no limit.' },
    { label: 'largeReviewStructuralSkip', description: 'On big PRs (≥100 files) skip structural files (Unity scenes/prefabs/controllers, Android res/, helm/k8s, Xcode pbxproj) so their diff hunks never reach the model. Path rules pinned to deep still win.' },
    { label: 'skipAllStructuralFiles', description: 'Always skip structural files regardless of review size. Use this when scene/prefab/manifest churn never produces actionable findings. Supersedes the large-review-only flag. Path rules pinned to deep still win.' },
  ],
  prompt: [
    { label: 'promptAppend', description: 'Extra review guidance injected into every review prompt. Best for risk focus, rollout concerns, and team-specific review priorities.' },
  ],
  linters: [
    { label: 'enabled', description: 'Master toggle — when off, Atlas skips all linter pre-passes.' },
    { label: 'Per-tool toggles', description: 'Enable or disable individual linters. Only tools detected in the project or available as Atlas fallback can be enabled.' },
    { label: 'mode', description: 'In JSON, set "mode": "project_only" to never use Atlas-managed fallback, or "fallback_if_missing" (default) to let Atlas fill in.' },
  ],
  paths: [
    { label: 'glob', description: 'A glob pattern matched against each file in the diff. First matching rule wins.' },
    { label: 'fileClass', description: 'Controls review depth: deep (full line-by-line), structural (API/logic focus), shallow (light review), collapsed (summary only), skip (excluded).' },
    { label: 'promptAppend', description: 'Optional per-path instructions injected only when this rule matches.' },
    { label: 'mustCheckRules', description: 'Optional list of rules that Atlas must evaluate for matching files (advanced, edit via JSON tab).' },
  ],
};

const REVIEW_POLICY_LINTER_ORDER = ['eslint', 'tsc', 'dotnet', 'dotnetFormat', 'semgrep'] as const;

const REVIEW_POLICY_LINTER_LABELS: Record<(typeof REVIEW_POLICY_LINTER_ORDER)[number], string> = {
  eslint: 'ESLint',
  tsc: 'TypeScript',
  dotnet: '.NET',
  dotnetFormat: '.NET conventions',
  semgrep: 'Semgrep',
};

const REVIEW_POLICY_LINTER_ENABLE_HINTS: Record<(typeof REVIEW_POLICY_LINTER_ORDER)[number], string> = {
  eslint: 'Add ESLint to this project with a supported config to enable this linter.',
  tsc: 'Add TypeScript to this project with tsconfig.json to enable this linter.',
  dotnet: 'Add a .csproj or .sln to this project to enable this linter.',
  dotnetFormat: 'Add a .csproj or .sln to this project to enable C# formatting and conventions checks.',
  semgrep: 'Add Semgrep config to this project or use Atlas fallback when available.',
};

const REVIEW_POLICY_FILE_CLASSES = ['deep', 'structural', 'shallow', 'collapsed', 'skip'] as const;
type ReviewPolicyFileClass = (typeof REVIEW_POLICY_FILE_CLASSES)[number];

const FILE_CLASS_LABELS: Record<ReviewPolicyFileClass, string> = {
  deep: 'Deep',
  structural: 'Structural',
  shallow: 'Shallow',
  collapsed: 'Collapsed',
  skip: 'Skip',
};

const FILE_CLASS_DESCRIPTIONS: Record<ReviewPolicyFileClass, string> = {
  deep: 'Full line-by-line review',
  structural: 'Focus on API & logic changes',
  shallow: 'Light review (tests, styles)',
  collapsed: 'Show in summary only',
  skip: 'Exclude from review',
};

const REVIEW_POLICY_EXAMPLES: Array<{
  id: string;
  label: string;
  description: string;
  snippet: Record<string, unknown>;
}> = [
  {
    id: 'prompt-high-risk-backend',
    label: 'Prompt: high-risk backend flows',
    description: 'Useful when your team wants Atlas to be especially strict on auth, billing, and destructive operations.',
    snippet: {
      promptAppend: [
        'Treat authentication, authorization, billing, payment, and data-deletion flows as high risk. Prioritize permission checks, missing validation, rollback gaps, unsafe defaults, and tenant-isolation issues.',
      ],
    },
  },
  {
    id: 'prompt-migrations-rollout',
    label: 'Prompt: migrations and rollout safety',
    description: 'Useful for teams that want stronger scrutiny on schema, infra, and deploy-sequence changes.',
    snippet: {
      promptAppend: [
        'Be strict on schema, migration, and infrastructure changes. Look for backward compatibility issues, deploy-order hazards, rollback gaps, and environment-specific breakage.',
      ],
    },
  },
  {
    id: 'prompt-pragmatic-review',
    label: 'Prompt: pragmatic review',
    description: 'Useful when teams want less style noise and more focus on correctness, regressions, and operability.',
    snippet: {
      promptAppend: [
        'Prioritize correctness, regressions, security, and operability. Ignore style-only feedback unless it materially affects maintainability or causes bugs.',
      ],
    },
  },
  {
    id: 'unity-lifecycle-review',
    label: 'Unity: lifecycle and scheduler checks',
    description: 'Useful for Unity teams that want Atlas to look for InvokeRepeating misuse, missing CancelInvoke cleanup, and risky MonoBehaviour lifecycle/state patterns.',
    snippet: {
      promptAppend: [
        'For Unity and C# changes, explicitly look for unsafe InvokeRepeating usage, missing CancelInvoke cleanup, MonoBehaviour lifecycle/state misuse, main-thread hazards, and scene or object lifetime bugs.',
      ],
      paths: [
        {
          glob: 'Assets/**/*.cs',
          fileClass: 'deep',
          promptAppend: 'Check Awake/Start/OnEnable/OnDisable/OnDestroy interactions, InvokeRepeating or Invoke setup and cleanup, MonoBehaviour ownership and state transitions, and Unity main-thread lifecycle hazards.',
        },
      ],
    },
  },
];

function normalizePolicyPromptAppendEntries(...sources: unknown[]) {
  const seen = new Set<string>();
  const entries: string[] = [];

  for (const source of sources) {
    const values = Array.isArray(source)
      ? source
      : typeof source === 'string'
        ? [source]
        : [];

    for (const value of values) {
      const normalized = typeof value === 'string' ? value.trim() : '';
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      entries.push(normalized);
    }
  }

  return entries;
}

function dedupePolicyEntries(entries: unknown[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeReviewPolicySnippetContent(currentContent: string, snippet: Record<string, unknown>) {
  const parsed = JSON.parse(currentContent);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Review policy must be a JSON object');
  }

  const nextPolicy = {
    ...parsed,
    defaults: {
      ...((parsed as Record<string, any>).defaults && typeof (parsed as Record<string, any>).defaults === 'object' ? (parsed as Record<string, any>).defaults : {}),
      ...(snippet.defaults && typeof snippet.defaults === 'object' && !Array.isArray(snippet.defaults) ? snippet.defaults : {}),
    },
    promptAppend: normalizePolicyPromptAppendEntries(
      (parsed as Record<string, any>).promptAppend,
      (parsed as Record<string, any>).prompt?.reviewAppend,
      snippet.promptAppend
    ),
    rules: {
      suppressionRules: dedupePolicyEntries([
        ...(((parsed as Record<string, any>).rules?.suppressionRules && Array.isArray((parsed as Record<string, any>).rules.suppressionRules))
          ? (parsed as Record<string, any>).rules.suppressionRules
          : []),
        ...((snippet.rules && typeof snippet.rules === 'object' && !Array.isArray(snippet.rules) && Array.isArray((snippet.rules as Record<string, unknown>).suppressionRules))
          ? (snippet.rules as Record<string, unknown>).suppressionRules as unknown[]
          : []),
      ]),
      mustCheckRules: dedupePolicyEntries([
        ...(((parsed as Record<string, any>).rules?.mustCheckRules && Array.isArray((parsed as Record<string, any>).rules.mustCheckRules))
          ? (parsed as Record<string, any>).rules.mustCheckRules
          : []),
        ...((snippet.rules && typeof snippet.rules === 'object' && !Array.isArray(snippet.rules) && Array.isArray((snippet.rules as Record<string, unknown>).mustCheckRules))
          ? (snippet.rules as Record<string, unknown>).mustCheckRules as unknown[]
          : []),
      ]),
    },
    paths: dedupePolicyEntries([
      ...(((parsed as Record<string, any>).paths && Array.isArray((parsed as Record<string, any>).paths))
        ? (parsed as Record<string, any>).paths
        : []),
      ...((snippet.paths && Array.isArray(snippet.paths)) ? snippet.paths : []),
    ]),
  } as Record<string, unknown>;

  delete (nextPolicy as Record<string, unknown>).prompt;
  if (
    !(Array.isArray((nextPolicy.rules as Record<string, unknown> | undefined)?.suppressionRules)
      && ((nextPolicy.rules as Record<string, unknown>).suppressionRules as unknown[]).length > 0)
    && !(Array.isArray((nextPolicy.rules as Record<string, unknown> | undefined)?.mustCheckRules)
      && ((nextPolicy.rules as Record<string, unknown>).mustCheckRules as unknown[]).length > 0)
  ) {
    delete nextPolicy.rules;
  }

  return `${JSON.stringify(nextPolicy, null, 2)}\n`;
}

function parseReviewPolicyEditorContent(content: string): { policy: Record<string, any> | null; error: string | null } {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        policy: null,
        error: 'Review policy must be a JSON object before structured controls can edit it.',
      };
    }
    return { policy: parsed as Record<string, any>, error: null };
  } catch (error: any) {
    return {
      policy: null,
      error: error?.message || 'Review policy must be valid JSON before structured controls can edit it.',
    };
  }
}

function formatReviewPolicyContent(policy: Record<string, unknown>) {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

function updateReviewPolicyContent(
  currentContent: string,
  updateFn: (policy: Record<string, any>) => void
) {
  const parsed = parseReviewPolicyEditorContent(currentContent);
  if (!parsed.policy) {
    throw new Error(parsed.error || 'Review policy is invalid JSON.');
  }
  const nextPolicy = JSON.parse(JSON.stringify(parsed.policy)) as Record<string, any>;
  updateFn(nextPolicy);
  return formatReviewPolicyContent(nextPolicy);
}

function normalizePolicyDocument(value: unknown): ReviewPolicyDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const document = value as Record<string, any>;
  const normalized: ReviewPolicyDocument = {
    ...document,
    promptAppend: normalizePolicyPromptAppendEntries(document.promptAppend, document.prompt?.reviewAppend),
  };
  delete (normalized as Record<string, unknown>).prompt;
  return normalized;
}

function SettingsSubtabBar({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: Array<{ id: string; label: string; icon: React.ReactNode }>;
  activeTab: string;
  onChange: (tabId: string) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        overflowX: 'auto',
        paddingBottom: 0,
        borderBottom: '1px solid var(--review-shell-divider)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: 'var(--review-shell-bg)',
        marginLeft: 'calc(-1 * var(--space-6))',
        marginRight: 'calc(-1 * var(--space-6))',
        paddingLeft: 'var(--space-6)',
        paddingRight: 'var(--space-6)',
        paddingTop: 'var(--space-3)',
      }}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            role="tab"
            aria-selected={isActive}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              padding: '9px 14px',
              marginBottom: 'var(--space-2)',
              border: 'none',
              borderBottom: isActive ? '2px solid var(--accent-blue)' : '2px solid transparent',
              borderRadius: 0,
              background: 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-sans)',
              fontWeight: isActive ? 800 : 700,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--text-primary)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--text-secondary)';
              }
            }}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function ReviewSection() {
  const [activeTab, setActiveTab] = useState<ReviewSettingsTab>('ai_provider');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <SettingsSubtabBar
        tabs={REVIEW_SETTINGS_TABS}
        activeTab={activeTab}
        onChange={(tab) => setActiveTab(tab as ReviewSettingsTab)}
      />

      <div>
        {activeTab === 'ai_provider' && <ReviewAiProviderSection />}
        {activeTab === 'policy' && <ReviewPolicySection />}
        {activeTab === 'git' && <GitSection />}
      </div>
    </div>
  );
}

function ReviewAiProviderSection() {
  // Branch auto-review toggle
  const [autoReview, setAutoReview] = useState(false);
  // Review depth
  const [reviewDepth, setReviewDepth] = useState('balanced');
  // Risk threshold
  const [riskThreshold, setRiskThreshold] = useState('high');
  // Focus areas
  const [focusAreas, setFocusAreas] = useState<string[]>(
    DEFAULT_FOCUS_AREAS.filter((f) => f.defaultOn).map((f) => f.key),
  );
  // Ignore patterns
  const [ignorePatterns, setIgnorePatterns] = useState<string>(DEFAULT_IGNORE_PATTERNS.join('\n'));
  const [selectedIgnorePreset, setSelectedIgnorePreset] = useState<string>(REVIEW_IGNORE_PATTERN_PRESETS[0]?.id || 'javascript_typescript');
  const [ignorePatternsByPreset, setIgnorePatternsByPreset] = useState<Record<string, string[]>>({});
  // Review model strategy
  const [reviewModelConfig, setReviewModelConfig] = useState<ReviewModelConfig>({
    strategy: 'smart',
    customModels: {},
    adaptive: { ...DEFAULT_REVIEW_MODEL_ADAPTIVE },
    rollout: { ...DEFAULT_REVIEW_MODEL_ROLLOUT },
  });
  const [reviewModelWarning, setReviewModelWarning] = useState<string | null>(null);
  const [reviewModelProviderType, setReviewModelProviderType] = useState<string>('anthropic');
  const [reviewModelProviderSource, setReviewModelProviderSource] = useState<string>('byok');
  // Execution mode order
  const [executionModeOrder, setExecutionModeOrder] = useState<string[]>([]);
  const executionModeOrderRef = useRef<string[]>([]);
  const pointerDragRef = useRef<{ mode: string; startY: number; currentY: number } | null>(null);
  const rowRectsRef = useRef<Array<{ mode: string; top: number; bottom: number; mid: number }>>([]);
  const [draggingMode, setDraggingMode] = useState<string | null>(null);
  const [dropTargetMode, setDropTargetMode] = useState<string | null>(null);
  const [executionModeOrderExpanded, setExecutionModeOrderExpanded] = useState(false);
  const [reviewModelProviderConfigs, setReviewModelProviderConfigs] = useState<Array<{
    type: string;
    label: string;
    models: Array<{ id: string; label: string }>;
    defaultModel: string;
    reviewModelDefaults?: {
      triage?: string | null;
      review?: string | null;
      synthesis?: string | null;
    };
    cliReviewModelDefaults?: {
      triage?: string | null;
      review?: string | null;
      synthesis?: string | null;
    };
  }>>([]);
  const ignoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [loading, setLoading] = useState(true);

  const sanitizeCustomModels = useCallback((customModels: ReviewModelConfig['customModels'], providerType: string) => {
    const providerConfig = reviewModelProviderConfigs.find((cfg) => cfg.type === providerType);
    if (!providerConfig) {
      return {
        sanitized: customModels || {},
        hadInvalid: false,
      };
    }
    const validModelIds = new Set(providerConfig.models.map((model) => model.id));
    const next: ReviewModelConfig['customModels'] = {};
    let hadInvalid = false;
    for (const phase of ['triage', 'review', 'synthesis'] as const) {
      const value = customModels?.[phase];
      if (!value) continue;
      if (validModelIds.has(value)) {
        next[phase] = value;
      } else {
        hadInvalid = true;
      }
    }
    return { sanitized: next, hadInvalid };
  }, [reviewModelProviderConfigs]);

  // Load settings on mount
  useEffect(() => {
    loadReviewSettings();
    return () => {
      if (ignoreTimerRef.current) clearTimeout(ignoreTimerRef.current);
    };
  }, []);

  // Keep ref in sync so dragEnd always reads latest order
  useEffect(() => {
    executionModeOrderRef.current = executionModeOrder;
  }, [executionModeOrder]);

  const loadReviewSettings = async () => {
    try {
      const [
        autoRes,
        depthRes,
        riskRes,
        focusRes,
        ignoreRes,
        selectedIgnorePresetRes,
        ignorePatternsByPresetRes,
        modelConfigRes,
        providerConfigsRes,
        providerListRes,
        modeOrderRes,
      ] = await Promise.allSettled([
        settingsApi.get('auto_review_enabled'),
        settingsApi.get('review_depth'),
        settingsApi.get('review_risk_threshold'),
        settingsApi.get('review_focus_areas'),
        settingsApi.get('review_ignore_patterns'),
        settingsApi.get('review_ignore_patterns_selected_preset'),
        settingsApi.get('review_ignore_patterns_by_preset'),
        settingsApi.getReviewModelConfig(),
        providerApi.getConfigs(),
        providerApi.list(),
        settingsApi.get('review_execution_mode_order'),
      ]);

      if (autoRes.status === 'fulfilled' && autoRes.value.value !== null) {
        setAutoReview(autoRes.value.value !== 'false');
      }
      if (depthRes.status === 'fulfilled' && depthRes.value.exists && depthRes.value.value) {
        setReviewDepth(depthRes.value.value);
      }
      if (riskRes.status === 'fulfilled' && riskRes.value.exists && riskRes.value.value) {
        setRiskThreshold(riskRes.value.value);
      }
      if (focusRes.status === 'fulfilled' && focusRes.value.exists && focusRes.value.value) {
        try {
          const parsed = JSON.parse(focusRes.value.value);
          if (Array.isArray(parsed)) setFocusAreas(parsed);
        } catch { /* use defaults */ }
      }
      let savedIgnorePatterns: string[] = [];
      if (ignoreRes.status === 'fulfilled' && ignoreRes.value.exists && ignoreRes.value.value) {
        try {
          const parsed = JSON.parse(ignoreRes.value.value);
          if (Array.isArray(parsed)) savedIgnorePatterns = parsed
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);
        } catch { /* use defaults */ }
      }
      const defaultPresetId = REVIEW_IGNORE_PATTERN_PRESETS[0]?.id || 'javascript_typescript';
      const savedSelectedPreset =
        selectedIgnorePresetRes.status === 'fulfilled' &&
        selectedIgnorePresetRes.value.exists &&
        selectedIgnorePresetRes.value.value &&
        REVIEW_IGNORE_PATTERN_PRESETS.some((preset) => preset.id === selectedIgnorePresetRes.value.value)
          ? selectedIgnorePresetRes.value.value
          : defaultPresetId;
      const nextIgnorePatternsByPreset: Record<string, string[]> = {};
      if (
        ignorePatternsByPresetRes.status === 'fulfilled' &&
        ignorePatternsByPresetRes.value.exists &&
        ignorePatternsByPresetRes.value.value
      ) {
        try {
          const parsed = JSON.parse(ignorePatternsByPresetRes.value.value);
          if (parsed && typeof parsed === 'object') {
            for (const preset of REVIEW_IGNORE_PATTERN_PRESETS) {
              const value = (parsed as Record<string, unknown>)[preset.id];
              if (!Array.isArray(value)) continue;
              const normalized = value
                .map((entry) => String(entry || '').trim())
                .filter(Boolean)
                .slice(0, 300);
              if (normalized.length > 0) {
                nextIgnorePatternsByPreset[preset.id] = Array.from(new Set(normalized));
              }
            }
          }
        } catch { /* use defaults */ }
      }
      if (savedIgnorePatterns.length > 0 && !nextIgnorePatternsByPreset[savedSelectedPreset]) {
        nextIgnorePatternsByPreset[savedSelectedPreset] = Array.from(new Set(savedIgnorePatterns));
      }
      const activePreset = REVIEW_IGNORE_PATTERN_PRESETS.find((preset) => preset.id === savedSelectedPreset);
      const activeIgnorePatterns = nextIgnorePatternsByPreset[savedSelectedPreset]
        || activePreset?.patterns
        || DEFAULT_IGNORE_PATTERNS;
      setSelectedIgnorePreset(savedSelectedPreset);
      setIgnorePatternsByPreset(nextIgnorePatternsByPreset);
      setIgnorePatterns(activeIgnorePatterns.join('\n'));

      const nextProviderConfigs =
        providerConfigsRes.status === 'fulfilled'
          ? providerConfigsRes.value.configs
          : [];
      setReviewModelProviderConfigs(nextProviderConfigs);
      const activeProviderType =
        providerListRes.status === 'fulfilled' && providerListRes.value.activeProvider?.type
          ? providerListRes.value.activeProvider.type
          : nextProviderConfigs[0]?.type || 'anthropic';
      setReviewModelProviderType(activeProviderType);
      const activeProviderSource =
        providerListRes.status === 'fulfilled' && providerListRes.value.activeProvider?.source
          ? providerListRes.value.activeProvider.source
          : 'byok';
      setReviewModelProviderSource(activeProviderSource);

      if (modelConfigRes.status === 'fulfilled') {
        const loaded = modelConfigRes.value;
        const validIds = new Set(
          (nextProviderConfigs.find((cfg) => cfg.type === activeProviderType)?.models || []).map((model) => model.id)
        );
        const sanitizedCustom: ReviewModelConfig['customModels'] = {};
        let hadInvalid = false;
        for (const phase of ['triage', 'review', 'synthesis'] as const) {
          const model = loaded.customModels?.[phase];
          if (!model) continue;
          if (validIds.size === 0 || validIds.has(model)) {
            sanitizedCustom[phase] = model;
          } else {
            hadInvalid = true;
          }
        }
        const normalizedConfig: ReviewModelConfig = {
          strategy: loaded.strategy,
          customModels: sanitizedCustom,
          adaptive: loaded.adaptive || { ...DEFAULT_REVIEW_MODEL_ADAPTIVE },
          rollout: loaded.rollout || { ...DEFAULT_REVIEW_MODEL_ROLLOUT },
        };
        setReviewModelConfig(normalizedConfig);
        if (hadInvalid) {
          setReviewModelWarning('Some custom models were unavailable for the active provider and were reset to safe fallbacks.');
          try {
            await settingsApi.setReviewModelConfig(normalizedConfig);
          } catch {
            // Keep UI warning; backend still has runtime fallback.
          }
        } else {
          setReviewModelWarning(null);
        }
      }

      // Load execution mode order
      let savedModeOrder: string[] = [];
      if (modeOrderRes.status === 'fulfilled' && modeOrderRes.value.exists && modeOrderRes.value.value) {
        try {
          const parsed = JSON.parse(modeOrderRes.value.value);
          if (Array.isArray(parsed)) savedModeOrder = parsed;
        } catch { /* use defaults */ }
      }
      // If user has a saved non-empty order, use it; otherwise compute default from provider source
      const effectiveOrder = savedModeOrder.length > 0
        ? savedModeOrder
        : computeDefaultModeOrder(activeProviderSource);
      setExecutionModeOrder(effectiveOrder);
    } catch {
      // Use defaults
    } finally {
      setLoading(false);
    }
  };

  const handleAutoReviewToggle = useCallback(async () => {
    const newValue = !autoReview;
    setAutoReview(newValue);
    try {
      await settingsApi.set('auto_review_enabled', String(newValue));
      emitAutoReviewSettingChanged(newValue);
    } catch {
      setAutoReview(!newValue);
      toast.error('Failed to save setting');
    }
  }, [autoReview]);

  const handleDepthChange = useCallback(async (value: string) => {
    setReviewDepth(value);
    try {
      await settingsApi.set('review_depth', value);
    } catch {
      toast.error('Failed to save setting');
    }
  }, []);

  const availableExecutionModes = computeAvailableModes(reviewModelProviderSource, reviewModelProviderType);

  // Native mousedown-based reorder using direct DOM listeners via callback ref.
  // React's event delegation doesn't reliably deliver mouse/pointer events
  // in all environments, so we attach native listeners directly.
  // Callback ref ensures listeners are attached when the element mounts
  // (even if it mounts later due to tab switching).
  const modeContainerCleanupRef = useRef<(() => void) | null>(null);
  const modeContainerCallbackRef = useCallback((container: HTMLDivElement | null) => {
    // Clean up previous listeners
    if (modeContainerCleanupRef.current) {
      modeContainerCleanupRef.current();
      modeContainerCleanupRef.current = null;
    }
    if (!container) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]');
      if (!row || !row.dataset.mode) return;
      const mode = row.dataset.mode;
      e.preventDefault();

      // Measure all visible row positions
      const rows = container.querySelectorAll<HTMLElement>('[data-mode]');
      const rects: Array<{ mode: string; top: number; bottom: number; mid: number }> = [];
      rows.forEach((r) => {
        const rect = r.getBoundingClientRect();
        rects.push({ mode: r.dataset.mode!, top: rect.top, bottom: rect.bottom, mid: (rect.top + rect.bottom) / 2 });
      });
      rowRectsRef.current = rects;
      pointerDragRef.current = { mode, startY: e.clientY, currentY: e.clientY };
      setDraggingMode(mode);

      // Track which mode we last swapped with to prevent oscillation.
      // After swapping A↔B, don't swap them back until cursor visits a
      // different row (or no row). This is critical because multiple
      // mousemove events fire before requestAnimationFrame re-measures
      // the row rects, so the stale rects would trigger a reverse swap.
      let lastSwappedWith: string | null = null;
      const onMove = (ev: MouseEvent) => {
        const drag = pointerDragRef.current;
        if (!drag) return;
        drag.currentY = ev.clientY;
        const target = rowRectsRef.current.find((r) => ev.clientY >= r.top && ev.clientY <= r.bottom);
        if (!target || target.mode === drag.mode) {
          lastSwappedWith = null; // cursor left the target — allow future swaps
          setDropTargetMode(null);
          return;
        }
        setDropTargetMode(target.mode);
        if (target.mode === lastSwappedWith) return; // prevent oscillation
        const prev = executionModeOrderRef.current;
        const fromIdx = prev.indexOf(drag.mode);
        const toIdx = prev.indexOf(target.mode);
        if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
        const next = [...prev];
        next.splice(fromIdx, 1);
        next.splice(toIdx, 0, drag.mode);
        executionModeOrderRef.current = next;
        setExecutionModeOrder(next);
        lastSwappedWith = target.mode;
        // Re-measure rects after React re-render (double RAF to wait for commit)
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const rs = container.querySelectorAll<HTMLElement>('[data-mode]');
            const newRects: Array<{ mode: string; top: number; bottom: number; mid: number }> = [];
            rs.forEach((r) => {
              const rect = r.getBoundingClientRect();
              newRects.push({ mode: r.dataset.mode!, top: rect.top, bottom: rect.bottom, mid: (rect.top + rect.bottom) / 2 });
            });
            rowRectsRef.current = newRects;
          });
        });
      };

      const onUp = async () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        pointerDragRef.current = null;
        rowRectsRef.current = [];
        setDraggingMode(null);
        setDropTargetMode(null);
        const latestOrder = executionModeOrderRef.current;
        try {
          await settingsApi.set('review_execution_mode_order', JSON.stringify(latestOrder));
        } catch {
          toast.error('Failed to save execution mode order');
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    container.addEventListener('mousedown', onMouseDown);
    modeContainerCleanupRef.current = () => container.removeEventListener('mousedown', onMouseDown);
  }, []);

  const handleRiskThresholdChange = useCallback(async (value: string) => {
    setRiskThreshold(value);
    try {
      await settingsApi.set('review_risk_threshold', value);
    } catch {
      toast.error('Failed to save setting');
    }
  }, []);

  const handleFocusAreaToggle = useCallback(async (key: string) => {
    const updated = focusAreas.includes(key)
      ? focusAreas.filter((k) => k !== key)
      : [...focusAreas, key];
    setFocusAreas(updated);
    try {
      await settingsApi.set('review_focus_areas', JSON.stringify(updated));
    } catch {
      toast.error('Failed to save setting');
    }
  }, [focusAreas]);

  const normalizeIgnorePatternLines = useCallback((value: string): string[] => {
    const deduped = new Set<string>();
    for (const line of String(value || '').split('\n')) {
      const normalized = line.trim();
      if (!normalized) continue;
      deduped.add(normalized);
      if (deduped.size >= 300) break;
    }
    return Array.from(deduped);
  }, []);

  const getIgnorePresetDefaultLines = useCallback((presetId: string): string[] => {
    return REVIEW_IGNORE_PATTERN_PRESETS.find((preset) => preset.id === presetId)?.patterns || DEFAULT_IGNORE_PATTERNS;
  }, []);

  const handleIgnorePatternsChange = useCallback((value: string) => {
    setIgnorePatterns(value);
    if (ignoreTimerRef.current) clearTimeout(ignoreTimerRef.current);
    ignoreTimerRef.current = setTimeout(async () => {
      const lines = normalizeIgnorePatternLines(value);
      const nextIgnorePatternsByPreset = {
        ...ignorePatternsByPreset,
        [selectedIgnorePreset]: lines,
      };
      setIgnorePatternsByPreset(nextIgnorePatternsByPreset);
      try {
        await settingsApi.set('review_ignore_patterns_by_preset', JSON.stringify(nextIgnorePatternsByPreset));
        await settingsApi.set('review_ignore_patterns', JSON.stringify(lines));
      } catch {
        toast.error('Failed to save ignore patterns');
      }
    }, 500);
  }, [ignorePatternsByPreset, normalizeIgnorePatternLines, selectedIgnorePreset]);

  const handleAddPattern = useCallback(() => {
    const newVal = ignorePatterns.endsWith('\n') ? ignorePatterns : ignorePatterns + '\n';
    setIgnorePatterns(newVal);
    // Focus textarea at end
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = textareaRef.current.value.length;
        textareaRef.current.selectionEnd = textareaRef.current.value.length;
      }
    }, 0);
  }, [ignorePatterns]);

  const handleIgnorePresetChange = useCallback(async (presetId: string) => {
    if (presetId === selectedIgnorePreset) return;
    const currentLines = normalizeIgnorePatternLines(ignorePatterns);
    const nextIgnorePatternsByPreset = {
      ...ignorePatternsByPreset,
      [selectedIgnorePreset]: currentLines,
    };
    const nextLines = nextIgnorePatternsByPreset[presetId] || getIgnorePresetDefaultLines(presetId);
    setIgnorePatternsByPreset(nextIgnorePatternsByPreset);
    setSelectedIgnorePreset(presetId);
    setIgnorePatterns(nextLines.join('\n'));
    if (ignoreTimerRef.current) clearTimeout(ignoreTimerRef.current);
    try {
      await settingsApi.set('review_ignore_patterns_selected_preset', presetId);
      await settingsApi.set('review_ignore_patterns_by_preset', JSON.stringify(nextIgnorePatternsByPreset));
      await settingsApi.set('review_ignore_patterns', JSON.stringify(nextLines));
    } catch {
      toast.error('Failed to switch ignore preset');
    }
  }, [getIgnorePresetDefaultLines, ignorePatterns, ignorePatternsByPreset, normalizeIgnorePatternLines, selectedIgnorePreset]);

  const normalizeRolloutAllowlist = useCallback((value: unknown): string[] => {
    if (!value) return [];
    const source = Array.isArray(value) ? value : String(value).split(/[\n,]/);
    const deduped = new Set<string>();
    for (const entry of source) {
      const normalized = String(entry || '').trim().toLowerCase();
      if (!normalized) continue;
      deduped.add(normalized);
      if (deduped.size >= 100) break;
    }
    return Array.from(deduped);
  }, []);

  const saveReviewModelConfig = useCallback(async (config: ReviewModelConfig, providerType: string) => {
    const { sanitized, hadInvalid } = sanitizeCustomModels(config.customModels, providerType);
    const strategy = config.strategy;
    const adaptive: ReviewModelAdaptiveConfig = {
      fastPathMaxFiles: Math.min(200, Math.max(1, Math.round(Number(config.adaptive?.fastPathMaxFiles) || DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxFiles))),
      fastPathMaxDiffChars: Math.min(1000000, Math.max(2000, Math.round(Number(config.adaptive?.fastPathMaxDiffChars) || DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxDiffChars))),
      preferQualityOnHighRisk: config.adaptive?.preferQualityOnHighRisk ?? DEFAULT_REVIEW_MODEL_ADAPTIVE.preferQualityOnHighRisk,
    };
    // Rollout controls were removed from settings; cost-aware routing is always enabled.
    const rollout: ReviewModelRolloutConfig = {
      mode: 'on',
      canaryPercent: DEFAULT_REVIEW_MODEL_ROLLOUT.canaryPercent,
      projectAllowlist: normalizeRolloutAllowlist(config.rollout?.projectAllowlist || []),
    };
    const nextConfig: ReviewModelConfig = {
      strategy,
      customModels: sanitized,
      adaptive,
      rollout,
    };
    setReviewModelConfig(nextConfig);
    try {
      await settingsApi.setReviewModelConfig(nextConfig);
      if (hadInvalid) {
        setReviewModelWarning('Some custom models are unavailable for the active provider and were reset.');
      } else {
        setReviewModelWarning(null);
      }
    } catch {
      toast.error('Failed to save review model settings');
    }
  }, [normalizeRolloutAllowlist, sanitizeCustomModels]);

  const handleReviewModelStrategyChange = useCallback(async (strategy: ReviewModelStrategy) => {
    await saveReviewModelConfig({
      strategy,
      customModels: reviewModelConfig.customModels || {},
      adaptive: reviewModelConfig.adaptive || { ...DEFAULT_REVIEW_MODEL_ADAPTIVE },
      rollout: reviewModelConfig.rollout || { ...DEFAULT_REVIEW_MODEL_ROLLOUT },
    }, reviewModelProviderType);
  }, [reviewModelConfig.customModels, reviewModelConfig.adaptive, reviewModelConfig.rollout, reviewModelProviderType, saveReviewModelConfig]);

  const handleCustomModelChange = useCallback(async (
    phase: 'triage' | 'review' | 'synthesis',
    model: string,
  ) => {
    const nextCustom = {
      ...(reviewModelConfig.customModels || {}),
      [phase]: model,
    };
    await saveReviewModelConfig({
      strategy: 'custom',
      customModels: nextCustom,
      adaptive: reviewModelConfig.adaptive || { ...DEFAULT_REVIEW_MODEL_ADAPTIVE },
      rollout: reviewModelConfig.rollout || { ...DEFAULT_REVIEW_MODEL_ROLLOUT },
    }, reviewModelProviderType);
  }, [reviewModelConfig.customModels, reviewModelConfig.adaptive, reviewModelConfig.rollout, reviewModelProviderType, saveReviewModelConfig]);

  const handleAdaptiveConfigChange = useCallback(async (
    updates: Partial<ReviewModelAdaptiveConfig>
  ) => {
    await saveReviewModelConfig({
      strategy: 'adaptive',
      customModels: reviewModelConfig.customModels || {},
      adaptive: {
        ...(reviewModelConfig.adaptive || DEFAULT_REVIEW_MODEL_ADAPTIVE),
        ...updates,
      },
      rollout: reviewModelConfig.rollout || { ...DEFAULT_REVIEW_MODEL_ROLLOUT },
    }, reviewModelProviderType);
  }, [reviewModelConfig.customModels, reviewModelConfig.adaptive, reviewModelConfig.rollout, reviewModelProviderType, saveReviewModelConfig]);

  const activeProviderModelConfig =
    reviewModelProviderConfigs.find((cfg) => cfg.type === reviewModelProviderType)
    || reviewModelProviderConfigs[0]
    || null;
  const allProviderModels = activeProviderModelConfig?.models || [];
  const reviewCapableModels = allProviderModels.filter((m: any) => m.reviewCapable !== false);
  const getCustomModelValue = (phase: 'triage' | 'review' | 'synthesis') => {
    const models = phase === 'triage' ? allProviderModels : reviewCapableModels;
    const hasModel = (modelId: string | null | undefined) => (
      Boolean(typeof modelId === 'string'
      && modelId.trim()
      && models.some((model) => model.id === modelId.trim()))
    );
    const selectedModel = reviewModelConfig.customModels?.[phase];
    if (hasModel(selectedModel)) return selectedModel as string;

    const providerDefaults = reviewModelProviderSource === 'cli_detected'
      ? activeProviderModelConfig?.cliReviewModelDefaults
      : activeProviderModelConfig?.reviewModelDefaults;
    const defaultForPhase = providerDefaults?.[phase];
    if (hasModel(defaultForPhase)) return defaultForPhase as string;
    if (hasModel(activeProviderModelConfig?.defaultModel)) return activeProviderModelConfig?.defaultModel as string;
    return models[0]?.id || '';
  };

  return (
    <div>
      {/* ---- Provider Selection ---- */}
      <ProviderSelector context="review" />

      <div style={{ height: 'var(--space-4)' }} />

      {/* ---- Branch Auto-Review ---- */}
      <div style={subsectionLabelStyle}>Auto-Review</div>
      <div style={cardStyle}>
        <ToggleRow
          label="Auto-review branch reviews"
          description="This is the global default for branch reviews. Can be overridden per project from the project review view."
          value={autoReview}
          onChange={handleAutoReviewToggle}
          disabled={loading}
        />
      </div>

      {/* ---- Review Model ---- */}
      <div style={subsectionLabelStyle}>Review Model</div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {REVIEW_MODEL_STRATEGY_OPTIONS.map((option) => (
            <label
              key={option.value}
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                alignItems: 'flex-start',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.5 : 1,
              }}
            >
              <input
                type="radio"
                name="review-model-strategy"
                checked={normalizeVisibleReviewModelStrategy(reviewModelConfig.strategy) === option.value}
                onChange={() => handleReviewModelStrategyChange(option.value)}
                disabled={loading}
                style={{ accentColor: 'var(--accent-blue)', marginTop: 2 }}
              />
              <span>
                <span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 500 }}>
                  {option.label}
                  {option.experimental && (
                    <span style={{
                      marginLeft: 6,
                      padding: '1px 5px',
                      borderRadius: 4,
                      border: '1px solid var(--accent-blue)',
                      color: 'var(--accent-blue)',
                      background: 'var(--chip-info-bg)',
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: 0,
                    }}>
                      Experimental
                    </span>
                  )}
                </span>
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </div>

        {reviewModelConfig.strategy === 'custom' && (
          <div style={{
            marginTop: 'var(--space-3)',
            borderTop: '1px solid var(--border-muted)',
            paddingTop: 'var(--space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}>
            <div>
              <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>
                Provider
              </label>
              <select
                value={reviewModelProviderType}
                onChange={(e) => setReviewModelProviderType(e.target.value)}
                disabled={loading}
                style={{ ...selectStyle, maxWidth: 260, opacity: loading ? 0.5 : 1 }}
              >
                {reviewModelProviderConfigs.map((config) => (
                  <option key={config.type} value={config.type}>{config.label}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 'var(--space-2)' }}>
              {([
                { key: 'triage', label: 'Triage model' },
                { key: 'review', label: 'Review model' },
                { key: 'synthesis', label: 'Synthesis model' },
              ] as const).map((entry) => (
                <div key={entry.key}>
                  <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>
                    {entry.label}
                  </label>
                  <select
                    value={getCustomModelValue(entry.key)}
                    onChange={(e) => handleCustomModelChange(entry.key, e.target.value)}
                    disabled={loading || (entry.key === 'triage' ? allProviderModels : reviewCapableModels).length === 0}
                    style={{ ...selectStyle, maxWidth: 320, opacity: loading ? 0.5 : 1 }}
                  >
                    {(entry.key === 'triage' ? allProviderModels : reviewCapableModels).map((model) => (
                      <option key={model.id} value={model.id}>{model.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {reviewModelConfig.strategy === 'adaptive' && (
          <div style={{
            marginTop: 'var(--space-3)',
            borderTop: '1px solid var(--border-muted)',
            paddingTop: 'var(--space-3)',
            display: 'grid',
            gridTemplateColumns: '1fr',
            gap: 'var(--space-3)',
          }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              Tune when Atlas uses cheaper models during review.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 'var(--space-2)' }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                  Fast path max files
                </span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={reviewModelConfig.adaptive?.fastPathMaxFiles ?? DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxFiles}
                  onChange={(e) => {
                    void handleAdaptiveConfigChange({ fastPathMaxFiles: Number(e.target.value) || DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxFiles });
                  }}
                  disabled={loading}
                  style={{ ...inputStyle, maxWidth: 220, opacity: loading ? 0.5 : 1 }}
                />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                  Fast path max diff chars
                </span>
                <input
                  type="number"
                  min={2000}
                  max={1000000}
                  step={500}
                  value={reviewModelConfig.adaptive?.fastPathMaxDiffChars ?? DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxDiffChars}
                  onChange={(e) => {
                    void handleAdaptiveConfigChange({ fastPathMaxDiffChars: Number(e.target.value) || DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxDiffChars });
                  }}
                  disabled={loading}
                  style={{ ...inputStyle, maxWidth: 220, opacity: loading ? 0.5 : 1 }}
                />
              </label>
            </div>
            <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              <input
                type="checkbox"
                checked={reviewModelConfig.adaptive?.preferQualityOnHighRisk ?? DEFAULT_REVIEW_MODEL_ADAPTIVE.preferQualityOnHighRisk}
                onChange={(e) => {
                  void handleAdaptiveConfigChange({ preferQualityOnHighRisk: e.target.checked });
                }}
                disabled={loading}
                style={{ accentColor: 'var(--accent-blue)' }}
              />
              Prefer higher-quality model when high-risk hints are present
            </label>
          </div>
        )}

        {reviewModelWarning && (
          <div style={{
            marginTop: 'var(--space-3)',
            fontSize: 'var(--text-xs)',
            color: 'var(--status-warning, #eab308)',
            background: 'rgba(234, 179, 8, 0.08)',
            border: '1px solid rgba(234, 179, 8, 0.25)',
            borderRadius: 'var(--radius-sm)',
            padding: 'var(--space-2) var(--space-3)',
          }}>
            {reviewModelWarning}
          </div>
        )}
      </div>

      {/* ---- Execution Mode Order ---- */}
      <div
        style={{
          ...cardStyle,
          padding: 0,
          overflow: 'hidden',
          marginBottom: 'var(--space-5)',
        }}
      >
        <button
          type="button"
          onClick={() => setExecutionModeOrderExpanded((current) => !current)}
          aria-expanded={executionModeOrderExpanded}
          style={{
            ...btnBase,
            width: '100%',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: 'var(--space-4)',
            background: 'transparent',
            color: 'var(--text-primary)',
          }}
        >
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
            <span
              style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-secondary)',
              }}
            >
              Execution Mode Order
            </span>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', textAlign: 'left' }}>
              Drag to reorder how review execution modes are tried. First available mode is used.
            </span>
          </span>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: '50%',
              border: '1px solid var(--border-default)',
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-tertiary)',
              flexShrink: 0,
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              style={{
                transform: executionModeOrderExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform var(--transition-fast)',
              }}
            >
              <path
                d="M4 6L8 10L12 6"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
        </button>

        {executionModeOrderExpanded && (
        <div
          style={{
            borderTop: '1px solid var(--border-default)',
            padding: 'var(--space-4)',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
        <div ref={modeContainerCallbackRef} data-mode-container="" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(() => {
            const availableOrdered = executionModeOrder.filter((m) => availableExecutionModes.has(m));
            return availableOrdered.map((mode, visibleIndex) => {
              const meta = EXECUTION_MODE_METADATA[mode];
              if (!meta) return null;
              const isDragging = draggingMode === mode;
              const isDropTarget = dropTargetMode === mode && !isDragging;
              return (
                <div
                  key={mode}
                  data-mode={mode}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-sm)',
                    border: isDropTarget
                      ? '2px solid var(--accent-blue, #3b82f6)'
                      : '1px solid var(--border-secondary)',
                    background: isDropTarget
                      ? 'rgba(59, 130, 246, 0.08)'
                      : 'var(--bg-secondary)',
                    cursor: loading ? 'not-allowed' : 'grab',
                    opacity: isDragging ? 0.5 : loading ? 0.5 : 1,
                    userSelect: 'none',
                    touchAction: 'none',
                    transition: 'border 0.15s, background 0.15s, opacity 0.15s',
                  }}
                >
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 14, lineHeight: 1, flexShrink: 0, cursor: loading ? 'not-allowed' : 'grab' }}>
                    ☰
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
                      {meta.label}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {meta.description}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 'var(--text-xs)',
                    color: visibleIndex === 0 ? 'var(--accent-blue, #3b82f6)' : 'var(--text-tertiary)',
                    fontWeight: visibleIndex === 0 ? 600 : 400,
                    flexShrink: 0,
                  }}>
                    #{visibleIndex + 1}
                  </span>
                </div>
              );
            });
          })()}
          {/* Unavailable modes shown greyed out */}
          {ALL_EXECUTION_MODES
            .filter((mode) => !availableExecutionModes.has(mode))
            .map((mode) => {
              const meta = EXECUTION_MODE_METADATA[mode];
              if (!meta) return null;
              return (
                <div
                  key={mode}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-secondary)',
                    background: 'var(--bg-primary)',
                    opacity: 0.35,
                    userSelect: 'none',
                  }}
                >
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 14, lineHeight: 1, flexShrink: 0 }}>
                    ☰
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-tertiary)' }}>
                      {meta.label} <span style={{ fontWeight: 400, fontStyle: 'italic' }}>(unavailable)</span>
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {meta.description}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
        </div>
        )}
      </div>

      {/* ---- Review Depth ---- */}
      <div style={subsectionLabelStyle}>Review Depth</div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
              Depth level
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
              {REVIEW_DEPTH_OPTIONS.find((o) => o.value === reviewDepth)?.description ?? ''}
            </div>
          </div>
          <select
            value={reviewDepth}
            onChange={(e) => handleDepthChange(e.target.value)}
            disabled={loading}
            style={{ ...selectStyle, maxWidth: 180, opacity: loading ? 0.5 : 1 }}
          >
            {REVIEW_DEPTH_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ---- Risk Threshold ---- */}
      <div style={subsectionLabelStyle}>Risk Threshold</div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
              Block push when risk is
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
              {RISK_THRESHOLD_OPTIONS.find((o) => o.value === riskThreshold)?.description ?? ''}
            </div>
          </div>
          <select
            value={riskThreshold}
            onChange={(e) => handleRiskThresholdChange(e.target.value)}
            disabled={loading}
            style={{ ...selectStyle, maxWidth: 180, opacity: loading ? 0.5 : 1 }}
          >
            {RISK_THRESHOLD_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-3)', paddingTop: 'var(--space-2)', borderTop: '1px solid var(--border-muted)' }}>
          When blocked, user must explicitly override.
        </div>
      </div>

      {/* ---- Focus Areas ---- */}
      <div style={subsectionLabelStyle}>Focus Areas</div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {DEFAULT_FOCUS_AREAS.map((area) => (
            <label
              key={area.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.5 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={focusAreas.includes(area.key)}
                onChange={() => handleFocusAreaToggle(area.key)}
                disabled={loading}
                style={{ accentColor: 'var(--accent-blue)', width: 14, height: 14 }}
              />
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                {area.label}
              </span>
            </label>
          ))}
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-3)', paddingTop: 'var(--space-2)', borderTop: '1px solid var(--border-muted)' }}>
          Disabling a focus area means the AI will not flag issues in that category.
        </div>
      </div>

      {/* ---- Ignore Patterns ---- */}
      <div style={subsectionLabelStyle}>Ignore Patterns</div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end', marginBottom: 'var(--space-3)' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>
              Tech stack preset
            </label>
            <select
              value={selectedIgnorePreset}
              onChange={(e) => { void handleIgnorePresetChange(e.target.value); }}
              disabled={loading}
              style={{ ...selectStyle, opacity: loading ? 0.5 : 1 }}
            >
              {REVIEW_IGNORE_PATTERN_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-2)' }}>
          Switching presets loads that stack&apos;s defaults unless you already customized it. Atlas also uses the preset as a stack hint for review shaping, while still respecting your ignore patterns and `.gitignore`.
        </div>
        <textarea
          ref={textareaRef}
          value={ignorePatterns}
          onChange={(e) => handleIgnorePatternsChange(e.target.value)}
          disabled={loading}
          rows={6}
          style={{
            ...inputStyle,
            resize: 'vertical',
            lineHeight: 1.6,
            opacity: loading ? 0.5 : 1,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-2)' }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            Glob patterns. One per line.
          </div>
          <button
            type="button"
            onClick={handleAddPattern}
            disabled={loading}
            style={{ ...btnSecondary, opacity: loading ? 0.5 : 1 }}
          >
            + Add pattern
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * CodeGraph per-project controls. Implements the two-state model from
 * the plan: `enabled` (user spec) and the latest index row (system
 * status) move independently. Toggle ON with no ready index → auto-init.
 * Toggle OFF leaves the index in place. Remove Index does NOT touch
 * `enabled` — see acceptance test T7.
 *
 * Selection is per-project; reuses the project list pattern from
 * `ReviewPolicySection`.
 */
function CodegraphSection() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [status, setStatus] = useState<CodegraphStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load project list once. projectApi.list returns
  // { success, projects: Project[] } — the API wraps the array.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await projectApi.list();
        if (cancelled) return;
        const projectList = Array.isArray(result?.projects) ? result.projects : [];
        setProjects(projectList);
        if (!selectedProjectId && projectList.length > 0) {
          setSelectedProjectId(projectList[0].id);
        }
      } catch {
        if (!cancelled) toast.error('Failed to load projects');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshStatus = useCallback(async (projectId: string): Promise<CodegraphStatus | null> => {
    if (!projectId) return null;
    try {
      const next = await codegraphApi.getStatus(projectId);
      setStatus(next);
      return next;
    } catch {
      toast.error('Failed to read CodeGraph status');
      return null;
    }
  }, []);

  // One-shot fetch when the project selection changes. Polling lives in a
  // separate effect below so it can react to state transitions that happen
  // *within* a project (e.g. clicking "Enable" kicks off an index without
  // a project switch — the prior single-effect version polled only on
  // project change and missed the indexing → ready transition).
  useEffect(() => {
    if (!selectedProjectId) return;
    setStatus(null);
    void refreshStatus(selectedProjectId);
  }, [selectedProjectId, refreshStatus]);

  // State-driven polling: whenever the latest known state is 'indexing',
  // poll until it isn't. Triggers on every transition into 'indexing'
  // regardless of cause (project switch, toggle ON, re-index, etc.). The
  // cleanup stops polling on transitions out of 'indexing' — no manual
  // stop logic needed inside the loop.
  useEffect(() => {
    if (!selectedProjectId) return;
    if (status?.index?.state !== 'indexing') return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await refreshStatus(selectedProjectId);
      if (stopped) return;
      pollTimerRef.current = setTimeout(tick, 1500);
    };
    pollTimerRef.current = setTimeout(tick, 1500);
    return () => {
      stopped = true;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [selectedProjectId, status?.index?.state, refreshStatus]);

  const enabled = status?.enabled === true;
  const indexRow = status?.index || null;
  const indexState = indexRow?.state || null;
  const cliAvailable = status?.cliAvailable !== false;

  const progressPct = useMemo(() => {
    if (!indexRow || indexState !== 'indexing') return null;
    if (!indexRow.totalFiles) return null;
    return Math.min(99, Math.round((indexRow.filesIndexed / indexRow.totalFiles) * 100));
  }, [indexRow, indexState]);

  const handleToggleEnabled = useCallback(async (next: boolean) => {
    if (!selectedProjectId || mutating) return;
    setMutating(true);
    try {
      const res = await codegraphApi.setEnabled(selectedProjectId, next);
      setStatus(res);
      // Two-state model: turning ON when no ready index exists triggers
      // an auto-init so the toggle isn't trapped at "enabled but pending"
      // forever (T2 in the plan's acceptance tests).
      if (next && (!res.index || res.index.state === 'stale' || res.index.state === 'error')) {
        if (res.cliAvailable) {
          const initRes = await codegraphApi.init(selectedProjectId);
          setStatus(initRes);
        }
      }
    } catch (err: any) {
      toast.error(describeApiError(err, 'Failed to update CodeGraph toggle'));
    } finally {
      setMutating(false);
    }
  }, [selectedProjectId, mutating]);

  const handleInit = useCallback(async () => {
    if (!selectedProjectId || mutating) return;
    setMutating(true);
    try {
      const res = await codegraphApi.init(selectedProjectId);
      setStatus(res);
    } catch (err: any) {
      toast.error(describeApiError(err, 'Failed to start CodeGraph init'));
    } finally {
      setMutating(false);
    }
  }, [selectedProjectId, mutating]);

  const handleRemove = useCallback(async () => {
    if (!selectedProjectId || mutating) return;
    setMutating(true);
    try {
      const res = await codegraphApi.uninit(selectedProjectId);
      setStatus(res);
      setConfirmRemove(false);
    } catch (err: any) {
      toast.error(describeApiError(err, 'Failed to remove CodeGraph index'));
    } finally {
      setMutating(false);
    }
  }, [selectedProjectId, mutating]);

  // Pill rendering — mirrors CodegraphStatusBadge logic but inline-sized.
  let pillLabel = 'Not initialized';
  let pillColor = 'var(--text-tertiary, #888)';
  if (!cliAvailable) {
    pillLabel = 'CLI not installed';
    pillColor = '#f87171';
  } else if (indexState === 'indexing') {
    pillLabel = progressPct != null ? `Indexing ${progressPct}%` : 'Indexing…';
    pillColor = '#60a5fa';
  } else if (indexState === 'ready') {
    pillLabel = enabled ? 'Ready · in use' : 'Ready (toggle is off)';
    pillColor = enabled ? '#4ade80' : 'var(--text-secondary, #aaa)';
  } else if (indexState === 'error') {
    pillLabel = 'Error';
    pillColor = '#f87171';
  } else if (indexState === 'stale') {
    pillLabel = 'Index removed';
    pillColor = 'var(--text-tertiary, #888)';
  } else if (!indexRow && enabled) {
    pillLabel = 'Index pending';
    pillColor = '#60a5fa';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
        CodeGraph is an external semantic-index MCP server
        (<code>@colbymchenry/codegraph</code>) the AI can call during reviews instead of
        running grep across the repo. Per-project, opt-in. Reviews only use the
        index when the toggle is ON <em>and</em> the index is ready for the
        current branch&apos;s HEAD SHA.
      </div>

      {/* Project selector */}
      <div>
        <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>
          Project
        </label>
        <select
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
          disabled={loading || projects.length === 0}
          style={{ width: '100%', maxWidth: 360, padding: '6px 8px', borderRadius: 6, background: 'var(--bg-input, #1f1f1f)', color: 'var(--text-primary)', border: '1px solid var(--border-default, #3a3a3a)' }}
        >
          {projects.length === 0
            ? <option value="">No projects</option>
            : projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
        </select>
      </div>

      {/* Toggle + status pill */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: mutating ? 'wait' : 'pointer' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => handleToggleEnabled(e.target.checked)}
              disabled={!selectedProjectId || mutating || !cliAvailable}
              style={{ accentColor: 'var(--accent-blue)', width: 16, height: 16 }}
            />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
              Enable CodeGraph for this project
            </span>
          </label>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginLeft: 24 }}>
            User intent. Turning ON with no index auto-initializes; turning OFF preserves the index for later re-enable.
          </div>
        </div>
        <div style={{
          fontSize: 11,
          fontWeight: 500,
          padding: '4px 10px',
          borderRadius: 999,
          background: 'var(--bg-secondary, #2a2a2a)',
          color: pillColor,
          border: `1px solid ${pillColor}33`,
          whiteSpace: 'nowrap',
        }}>
          {pillLabel}
        </div>
      </div>

      {/* Progress bar (while indexing) */}
      {indexState === 'indexing' && (
        <div>
          <div style={{
            height: 6,
            borderRadius: 3,
            background: 'var(--bg-secondary, #2a2a2a)',
            overflow: 'hidden',
            border: '1px solid var(--border-default, #3a3a3a)',
          }}>
            <div style={{
              height: '100%',
              width: progressPct != null ? `${progressPct}%` : '40%',
              background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
              transition: 'width 400ms ease',
            }} />
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 4 }}>
            {indexRow?.totalFiles
              ? `${indexRow.filesIndexed.toLocaleString()} / ${indexRow.totalFiles.toLocaleString()} files`
              : 'Building index…'}
          </div>
        </div>
      )}

      {/* Live log panel — visible while indexing OR for the last few seconds
          after, so a sub-second build still shows what happened. */}
      {(indexState === 'indexing' || (indexState === 'ready' && (status?.recentLogs?.length ?? 0) > 0)) && (
        <details
          open={indexState === 'indexing'}
          style={{
            fontSize: 'var(--text-xs)',
            color: 'var(--text-tertiary)',
            background: 'var(--bg-surface, #1a1a1a)',
            border: '1px solid var(--border-default, #3a3a3a)',
            borderRadius: 6,
            padding: 'var(--space-2)',
          }}
        >
          <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
            {indexState === 'indexing' ? 'Live output' : 'Last run output'}
            {status?.recentLogs?.length ? ` · ${status.recentLogs.length} line${status.recentLogs.length === 1 ? '' : 's'}` : ''}
          </summary>
          <div
            style={{
              marginTop: 'var(--space-2)',
              maxHeight: 200,
              overflow: 'auto',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {(status?.recentLogs ?? []).length === 0 ? (
              <div style={{ opacity: 0.6 }}>Waiting for codegraph output…</div>
            ) : (
              (status?.recentLogs ?? []).map((entry, i) => {
                const streamColor = entry.stream === 'stderr'
                  ? '#f87171'
                  : entry.stream === 'system'
                  ? '#60a5fa'
                  : 'var(--text-secondary, #aaa)';
                return (
                  <div key={`${entry.ts}-${i}`} style={{ color: streamColor }}>
                    <span style={{ opacity: 0.55, marginRight: 6 }}>
                      {new Date(entry.ts).toLocaleTimeString(undefined, { hour12: false })}
                    </span>
                    {entry.line}
                  </div>
                );
              })
            )}
          </div>
        </details>
      )}

      {/* Ready summary */}
      {indexState === 'ready' && indexRow && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div>
            {indexRow.nodes != null && (
              <>
                <strong style={{ color: 'var(--text-secondary)' }}>{indexRow.nodes.toLocaleString()}</strong> nodes
              </>
            )}
            {indexRow.edges != null && (
              <>
                {' · '}
                <strong style={{ color: 'var(--text-secondary)' }}>{indexRow.edges.toLocaleString()}</strong> edges
              </>
            )}
            {indexRow.sizeBytes != null && (
              <>
                {' · '}
                <strong style={{ color: 'var(--text-secondary)' }}>
                  {indexRow.sizeBytes >= 1024 * 1024
                    ? `${(indexRow.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                    : `${(indexRow.sizeBytes / 1024).toFixed(0)} KB`}
                </strong> on disk
              </>
            )}
          </div>
          <div>
            Built against SHA <code style={{ color: 'var(--text-secondary)' }}>{indexRow.worktreeSha?.slice(0, 12) || 'unknown'}</code>
            {indexRow.codegraphVersion ? ` · CodeGraph ${indexRow.codegraphVersion.replace(/^v/, 'v')}` : ''}
            {indexRow.readyAt ? ` · ready at ${new Date(indexRow.readyAt).toLocaleString()}` : ''}
          </div>
          <div>
            Reviews will use CodeGraph only when the toggle is ON and the review&apos;s head SHA matches the indexed SHA.
            If you change branches, you may need to re-index.
          </div>
        </div>
      )}

      {/* Error surface */}
      {indexState === 'error' && indexRow?.errorMessage && (
        <div style={{
          fontSize: 'var(--text-xs)',
          color: '#f87171',
          padding: 'var(--space-2)',
          background: 'rgba(239, 68, 68, 0.08)',
          borderRadius: 6,
          border: '1px solid rgba(239, 68, 68, 0.25)',
        }}>
          <div style={{ fontWeight: 500, marginBottom: 2 }}>Index build failed</div>
          <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {indexRow.errorMessage}
          </div>
        </div>
      )}

      {/* CLI missing surface */}
      {!cliAvailable && (
        <div style={{
          fontSize: 'var(--text-xs)',
          color: '#f87171',
          padding: 'var(--space-2)',
          background: 'rgba(239, 68, 68, 0.08)',
          borderRadius: 6,
          border: '1px solid rgba(239, 68, 68, 0.25)',
        }}>
          CodeGraph CLI not found on PATH. Install with:&nbsp;
          <code>npm i -g @colbymchenry/codegraph</code>
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {(!indexRow || indexState === 'stale' || indexState === 'error') && cliAvailable && (
          <button
            type="button"
            onClick={handleInit}
            disabled={!selectedProjectId || mutating}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              fontSize: 'var(--text-xs)',
              background: 'var(--accent-blue)',
              color: 'white',
              border: 'none',
              cursor: mutating ? 'wait' : 'pointer',
              opacity: mutating ? 0.6 : 1,
            }}
          >
            {indexState === 'error' ? 'Retry initialization' : 'Initialize index'}
          </button>
        )}
        {indexState === 'ready' && cliAvailable && (
          <button
            type="button"
            onClick={handleInit}
            disabled={!selectedProjectId || mutating}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              fontSize: 'var(--text-xs)',
              background: 'var(--bg-secondary, #2a2a2a)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-default, #3a3a3a)',
              cursor: mutating ? 'wait' : 'pointer',
              opacity: mutating ? 0.6 : 1,
            }}
          >
            Re-index
          </button>
        )}
        {indexRow && indexState !== 'stale' && (
          confirmRemove ? (
            <>
              <button
                type="button"
                onClick={handleRemove}
                disabled={mutating}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  fontSize: 'var(--text-xs)',
                  background: '#dc2626',
                  color: 'white',
                  border: 'none',
                  cursor: mutating ? 'wait' : 'pointer',
                  opacity: mutating ? 0.6 : 1,
                }}
              >
                Confirm remove
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                disabled={mutating}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  fontSize: 'var(--text-xs)',
                  background: 'transparent',
                  color: 'var(--text-tertiary)',
                  border: '1px solid var(--border-default, #3a3a3a)',
                  cursor: mutating ? 'wait' : 'pointer',
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              disabled={!selectedProjectId || mutating}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                fontSize: 'var(--text-xs)',
                background: 'transparent',
                color: '#f87171',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                cursor: mutating ? 'wait' : 'pointer',
                opacity: mutating ? 0.6 : 1,
              }}
            >
              Remove index
            </button>
          )
        )}
      </div>
    </div>
  );
}

function ReviewPolicySection() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [policyInfoSection, setPolicyInfoSection] = useState<PolicyInfoSection>(null);
  const [showTemplatesPopup, setShowTemplatesPopup] = useState(false);
  const [policyPath, setPolicyPath] = useState('.atlas/review-policy.json');
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [defaultContent, setDefaultContent] = useState('');
  const [fileExists, setFileExists] = useState(false);
  const [contentSource, setContentSource] = useState<'saved' | 'generated' | 'starter'>('starter');
  const [starterPolicy, setStarterPolicy] = useState<ReviewPolicyDocument | null>(null);
  const [linterStatus, setLinterStatus] = useState<ReviewPolicyLinterStatus>({});
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingPolicy, setLoadingPolicy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [policyEditorTab, setPolicyEditorTab] = useState<'visual' | 'json'>('visual');
  const [newPromptGuidance, setNewPromptGuidance] = useState('');
  const [newPathGlob, setNewPathGlob] = useState('');
  const [newPathFileClass, setNewPathFileClass] = useState<ReviewPolicyFileClass>('shallow');
  const [newPathPromptAppend, setNewPathPromptAppend] = useState('');
  const [expandedPathIndex, setExpandedPathIndex] = useState<number | null>(null);
  const [linterToolsExpanded, setLinterToolsExpanded] = useState(false);

  const handleBrowseFolder = useCallback(async () => {
    if (!selectedProjectId) return;
    const project = projects.find((p) => p.id === selectedProjectId);
    const projectPath = project?.path || undefined;

    if (isTauriEnvironment()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Select folder for path rule',
          defaultPath: projectPath,
        });
        if (typeof selected !== 'string' || !selected) return;
        // Compute project-relative path
        if (projectPath && selected.startsWith(projectPath)) {
          const relative = selected.slice(projectPath.length).replace(/^[/\\]+/, '');
          setNewPathGlob(relative ? `${relative}/**` : '**');
        } else {
          // Selected outside project — use folder name
          const name = selected.split(/[/\\]/).filter(Boolean).pop() || '';
          setNewPathGlob(name ? `**/${name}/**` : '**');
        }
        return;
      } catch {
        // Fall through to browser API
      }
    }

    // Browser fallback: File System Access API
    if (typeof (window as any).showDirectoryPicker === 'function') {
      try {
        const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' });
        const folderName: string = dirHandle.name;
        setNewPathGlob(`**/${folderName}/**`);
      } catch {
        // User cancelled
      }
    }
  }, [selectedProjectId, projects]);

  useEffect(() => {
    const loadProjects = async () => {
      setLoadingProjects(true);
      try {
        const result = await projectApi.list();
        setProjects(result.projects);
        if (result.projects.length > 0) {
          setSelectedProjectId((prev) => prev || result.projects[0].id);
        } else {
          setSelectedProjectId('');
          setContent('');
          setSavedContent('');
          setDefaultContent('');
          setFileExists(false);
          setContentSource('starter');
          setStarterPolicy(null);
          setLinterStatus({});
        }
      } catch {
        toast.error('Failed to load projects');
      } finally {
        setLoadingProjects(false);
      }
    };

    void loadProjects();
  }, []);

  const applyPolicyResponse = useCallback((response: Awaited<ReturnType<typeof reviewPolicyApi.get>>) => {
    setPolicyPath(response.path || '.atlas/review-policy.json');
    setContent(response.content || '');
    setSavedContent(response.content || '');
    setDefaultContent(response.defaultContent || '');
    setFileExists(response.exists === true);
    setContentSource(
      response.contentSource === 'saved'
        ? 'saved'
        : response.contentSource === 'generated'
          ? 'generated'
          : 'starter'
    );
    setStarterPolicy(normalizePolicyDocument(response.starterPolicy));
    setLinterStatus(response.linterStatus || {});
  }, []);

  const loadPolicy = useCallback(async (projectId: string) => {
    setLoadingPolicy(true);
    try {
      const response = await reviewPolicyApi.get(projectId);
      applyPolicyResponse(response);
    } catch (error) {
      toast.error(describeApiError(error, 'Failed to load review policy'));
      setContent('');
      setSavedContent('');
      setDefaultContent('');
      setFileExists(false);
      setContentSource('starter');
      setStarterPolicy(null);
      setLinterStatus({});
    } finally {
      setLoadingPolicy(false);
    }
  }, [applyPolicyResponse]);

  useEffect(() => {
    if (!selectedProjectId) {
      setContent('');
      setSavedContent('');
      setDefaultContent('');
      setFileExists(false);
      setContentSource('starter');
      setStarterPolicy(null);
      setLinterStatus({});
      return;
    }

    void loadPolicy(selectedProjectId);
  }, [loadPolicy, selectedProjectId]);

  const handleReload = useCallback(() => {
    if (!selectedProjectId) return;
    void loadPolicy(selectedProjectId);
  }, [loadPolicy, selectedProjectId]);

  const handleSave = useCallback(async () => {
    if (!selectedProjectId) return;
    setSaving(true);
    try {
      const response = await reviewPolicyApi.update(selectedProjectId, content);
      applyPolicyResponse(response);
      toast.success('Review policy saved');
    } catch (error) {
      toast.error(describeApiError(error, 'Failed to save review policy'));
    } finally {
      setSaving(false);
    }
  }, [applyPolicyResponse, content, selectedProjectId]);

  const loading = loadingProjects || loadingPolicy;
  const hasProjects = projects.length > 0;
  const isDirty = content !== savedContent;
  const parsedPolicyState = useMemo(() => parseReviewPolicyEditorContent(content), [content]);
  const editorPolicy = parsedPolicyState.policy;
  const editorPolicyError = parsedPolicyState.error;
  const controlsDisabled = loading || saving || !selectedProjectId || !editorPolicy;
  const starterLinterPolicy = starterPolicy?.linters && typeof starterPolicy.linters === 'object'
    ? starterPolicy.linters
    : null;
  const editorDefaults = editorPolicy?.defaults && typeof editorPolicy.defaults === 'object'
    ? editorPolicy.defaults
    : {};
  const editorLinterPolicy = editorPolicy?.linters && typeof editorPolicy.linters === 'object'
    ? editorPolicy.linters
    : null;
  const useStarterLinterFallbacks = !fileExists;
  const canPreviewStarter = Boolean(defaultContent && content !== defaultContent);
  const saveButtonLabel = fileExists
    ? 'Save policy'
    : contentSource === 'generated'
      ? 'Save active policy to repo'
      : 'Save starter as policy';
  const saveDisabled = loading
    || saving
    || !selectedProjectId
    || !content.trim()
    || (fileExists ? !isDirty : false);

  const updateStructuredPolicy = useCallback((updateFn: (policy: Record<string, any>) => void) => {
    try {
      setContent(updateReviewPolicyContent(content, updateFn));
    } catch (error) {
      toast.error(describeApiError(error, 'Fix the policy JSON before using structured controls'));
    }
  }, [content]);

  const handleRequireEvidenceToggle = useCallback((checked: boolean) => {
    updateStructuredPolicy((policy) => {
      policy.defaults = {
        ...(policy.defaults && typeof policy.defaults === 'object' ? policy.defaults : {}),
        requireEvidence: checked,
      };
    });
  }, [updateStructuredPolicy]);

  const handleAllowPraiseToggle = useCallback((checked: boolean) => {
    updateStructuredPolicy((policy) => {
      policy.defaults = {
        ...(policy.defaults && typeof policy.defaults === 'object' ? policy.defaults : {}),
        allowPraise: checked,
      };
    });
  }, [updateStructuredPolicy]);

  const handleMaxRecommendationsChange = useCallback((nextValue: string) => {
    updateStructuredPolicy((policy) => {
      const parsedValue = nextValue.trim() ? Math.max(1, Math.trunc(Number(nextValue) || 1)) : null;
      policy.defaults = {
        ...(policy.defaults && typeof policy.defaults === 'object' ? policy.defaults : {}),
        maxRecommendations: parsedValue,
      };
    });
  }, [updateStructuredPolicy]);

  const handleLargeReviewStructuralSkipToggle = useCallback((checked: boolean) => {
    updateStructuredPolicy((policy) => {
      policy.defaults = {
        ...(policy.defaults && typeof policy.defaults === 'object' ? policy.defaults : {}),
        largeReviewStructuralSkip: checked,
      };
    });
  }, [updateStructuredPolicy]);

  const handleSkipAllStructuralFilesToggle = useCallback((checked: boolean) => {
    updateStructuredPolicy((policy) => {
      policy.defaults = {
        ...(policy.defaults && typeof policy.defaults === 'object' ? policy.defaults : {}),
        skipAllStructuralFiles: checked,
      };
    });
  }, [updateStructuredPolicy]);

  const handleGlobalLinterToggle = useCallback((checked: boolean) => {
    updateStructuredPolicy((policy) => {
      policy.linters = {
        ...(policy.linters && typeof policy.linters === 'object' ? policy.linters : {}),
        enabled: checked,
      };
    });
  }, [updateStructuredPolicy]);

  const handleToolLinterToggle = useCallback((linterId: string, checked: boolean) => {
    updateStructuredPolicy((policy) => {
      policy.linters = {
        ...(policy.linters && typeof policy.linters === 'object' ? policy.linters : {}),
        [linterId]: {
          ...(
            policy.linters
            && typeof policy.linters === 'object'
            && policy.linters[linterId]
            && typeof policy.linters[linterId] === 'object'
              ? policy.linters[linterId]
              : {}
          ),
          enabled: checked,
        },
      };
    });
  }, [updateStructuredPolicy]);

  const resolvedGlobalLintersEnabled = editorLinterPolicy?.enabled !== undefined
    ? editorLinterPolicy.enabled !== false
    : useStarterLinterFallbacks && starterLinterPolicy?.enabled !== undefined
      ? starterLinterPolicy.enabled !== false
      : Object.values(linterStatus).some((entry) => entry.policyDefaultEligible || entry.runtimeReady);

  const editorPromptAppend: string[] = useMemo(() => {
    if (!editorPolicy) return [];
    const raw = (editorPolicy as Record<string, any>).promptAppend;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry: unknown) => typeof entry === 'string' && String(entry).trim());
  }, [editorPolicy]);

  const handleAddPromptGuidance = useCallback(() => {
    const trimmed = newPromptGuidance.trim();
    if (!trimmed) return;
    updateStructuredPolicy((policy) => {
      const existing = Array.isArray(policy.promptAppend) ? policy.promptAppend : [];
      policy.promptAppend = [...existing, trimmed];
    });
    setNewPromptGuidance('');
  }, [newPromptGuidance, updateStructuredPolicy]);

  const handleRemovePromptGuidance = useCallback((index: number) => {
    updateStructuredPolicy((policy) => {
      const existing = Array.isArray(policy.promptAppend) ? [...policy.promptAppend] : [];
      existing.splice(index, 1);
      policy.promptAppend = existing;
    });
  }, [updateStructuredPolicy]);

  const handleEditPromptGuidance = useCallback((index: number, value: string) => {
    updateStructuredPolicy((policy) => {
      const existing = Array.isArray(policy.promptAppend) ? [...policy.promptAppend] : [];
      existing[index] = value;
      policy.promptAppend = existing;
    });
  }, [updateStructuredPolicy]);

  // ── Path rules ──
  const editorPaths: Array<{ glob: string; fileClass: string | null; promptAppend?: string; mustCheckRules?: string[] }> = useMemo(() => {
    if (!editorPolicy) return [];
    const raw = (editorPolicy as Record<string, any>).paths;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry: unknown) => entry && typeof entry === 'object' && typeof (entry as any).glob === 'string');
  }, [editorPolicy]);

  const handleAddPathRule = useCallback(() => {
    const glob = newPathGlob.trim();
    if (!glob) return;
    const rule: Record<string, any> = { glob, fileClass: newPathFileClass };
    const prompt = newPathPromptAppend.trim();
    if (prompt) rule.promptAppend = prompt;
    updateStructuredPolicy((policy) => {
      const existing = Array.isArray(policy.paths) ? policy.paths : [];
      policy.paths = [...existing, rule];
    });
    setNewPathGlob('');
    setNewPathFileClass('shallow');
    setNewPathPromptAppend('');
  }, [newPathGlob, newPathFileClass, newPathPromptAppend, updateStructuredPolicy]);

  const handleRemovePathRule = useCallback((index: number) => {
    updateStructuredPolicy((policy) => {
      const existing = Array.isArray(policy.paths) ? [...policy.paths] : [];
      existing.splice(index, 1);
      policy.paths = existing;
    });
    setExpandedPathIndex(null);
  }, [updateStructuredPolicy]);

  const handleEditPathFileClass = useCallback((index: number, fileClass: string) => {
    updateStructuredPolicy((policy) => {
      const existing = Array.isArray(policy.paths) ? [...policy.paths] : [];
      if (existing[index]) {
        existing[index] = { ...existing[index], fileClass };
      }
      policy.paths = existing;
    });
  }, [updateStructuredPolicy]);

  const handleEditPathPromptAppend = useCallback((index: number, value: string) => {
    updateStructuredPolicy((policy) => {
      const existing = Array.isArray(policy.paths) ? [...policy.paths] : [];
      if (existing[index]) {
        const updated = { ...existing[index] };
        if (value.trim()) {
          updated.promptAppend = value;
        } else {
          delete updated.promptAppend;
        }
        existing[index] = updated;
      }
      policy.paths = existing;
    });
  }, [updateStructuredPolicy]);

  const handleApplyExample = useCallback((snippet: Record<string, unknown>) => {
    try {
      const merged = mergeReviewPolicySnippetContent(content, snippet);
      setContent(merged);
      toast.success('Template inserted into policy editor');
    } catch (error) {
      toast.error(describeApiError(error, 'Fix the policy JSON before inserting a template'));
    }
  }, [content]);

  const renderSectionInfoButton = (section: Exclude<PolicyInfoSection, null>) => (
    <button
      type="button"
      onClick={() => setPolicyInfoSection(policyInfoSection === section ? null : section)}
      title="Field reference"
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        color: policyInfoSection === section ? 'var(--accent-blue)' : 'var(--text-tertiary)',
        opacity: policyInfoSection === section ? 1 : 0.6,
        transition: 'color 0.15s, opacity 0.15s',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 11V7.5" />
        <circle cx="8" cy="5.5" r="0.5" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );

  const renderSectionHints = (section: Exclude<PolicyInfoSection, null>) => {
    if (policyInfoSection !== section) return null;
    const hints = SECTION_INFO[section];
    return (
      <div style={{
        padding: 'var(--space-2)',
        background: 'rgba(59, 130, 246, 0.06)',
        border: '1px solid rgba(59, 130, 246, 0.15)',
        borderRadius: 'var(--radius-md)',
        display: 'grid',
        gap: 'var(--space-2)',
      }}>
        {hints.map((hint) => (
          <div key={hint.label} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}>
            <code style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--accent-blue)',
              fontFamily: 'var(--font-mono)',
              flexShrink: 0,
              opacity: 0.9,
            }}>
              {hint.label}
            </code>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {hint.description}
            </span>
          </div>
        ))}
      </div>
    );
  };

  const policyTabStyle = (tab: 'visual' | 'json') => ({
    padding: '7px 16px',
    fontSize: 'var(--text-xs)',
    fontWeight: 600 as const,
    border: 'none',
    borderBottom: policyEditorTab === tab ? '2px solid var(--accent-blue)' : '2px solid transparent',
    background: 'none',
    color: policyEditorTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)',
    cursor: 'pointer' as const,
    transition: 'color 0.15s, border-color 0.15s',
  });

  const reviewPolicySourceBadge = contentSource === 'saved'
    ? {
        background: 'rgba(59, 130, 246, 0.12)',
        color: 'var(--accent-blue)',
        label: 'Saved',
      }
    : contentSource === 'generated'
      ? {
          background: 'rgba(34, 197, 94, 0.12)',
          color: 'var(--accent-green)',
          label: 'Generated default',
        }
      : {
          background: 'rgba(148, 163, 184, 0.16)',
          color: 'var(--text-secondary)',
          label: 'Starter preview',
        };

  return (
    <div>
      <div style={{ marginBottom: 'var(--space-3)' }}>
        <div style={{ ...subsectionLabelStyle, marginBottom: 0 }}>Review Policy</div>
      </div>

      <div style={{ ...cardStyle, marginBottom: 'var(--space-8)' }}>
        {/* Project selector */}
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-2)' }}>
            Project
          </label>
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            disabled={loadingProjects || !hasProjects}
            style={{ ...selectStyle, width: '100%', opacity: loadingProjects ? 0.5 : 1 }}
          >
            {!hasProjects && <option value="">No projects found</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        {/* Compact status line */}
        {selectedProjectId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
            <span style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: reviewPolicySourceBadge.background,
              color: reviewPolicySourceBadge.color,
              fontSize: 'var(--text-xs)',
              fontWeight: 600,
            }}>
              {reviewPolicySourceBadge.label}
            </span>
            {isDirty && (
              <>
                <span style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'rgba(245, 158, 11, 0.12)',
                  color: 'var(--status-warning, #f59e0b)',
                  fontSize: 'var(--text-xs)',
                  fontWeight: 600,
                }}>
                  Unsaved edits
                </span>
                <button
                  type="button"
                  onClick={() => setContent(savedContent)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '2px 6px',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--status-warning, #f59e0b)',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    textUnderlineOffset: 2,
                  }}
                >
                  Discard
                </button>
              </>
            )}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              <code style={{ fontSize: 'inherit' }}>{policyPath}</code>
            </span>
          </div>
        )}

        {!selectedProjectId && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>
            Select a project to create or edit its review policy file.
          </div>
        )}

        {/* Tab switcher */}
        {selectedProjectId && (
          <>
            <div style={{
              display: 'flex',
              gap: 0,
              borderBottom: '1px solid var(--border-muted)',
              marginBottom: 'var(--space-3)',
            }}>
              <button type="button" onClick={() => setPolicyEditorTab('visual')} style={policyTabStyle('visual')}>
                Visual Editor
              </button>
              <button type="button" onClick={() => setPolicyEditorTab('json')} style={policyTabStyle('json')}>
                JSON
              </button>
            </div>

            {/* Parse error banner (shown in both tabs) */}
            {editorPolicyError && (
              <div style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--status-warning, #f59e0b)',
                background: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.24)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-2)',
                marginBottom: 'var(--space-3)',
              }}>
                {policyEditorTab === 'visual'
                  ? `Visual editor is disabled — fix JSON errors in the JSON tab first. ${editorPolicyError}`
                  : editorPolicyError}
              </div>
            )}

            {/* ── Visual Editor Tab ── */}
            {policyEditorTab === 'visual' && (
              <div style={{ display: 'grid', gap: 'var(--space-3)', marginBottom: 'var(--space-3)', position: 'relative' }}>
                {loadingPolicy && (
                  <div style={{
                    position: 'absolute', inset: 0, zIndex: 2,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(10, 15, 26, 0.6)', borderRadius: 'var(--radius-md)',
                  }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: 999,
                      border: '2px solid rgba(148, 163, 184, 0.28)',
                      borderTopColor: 'var(--accent-blue)',
                      animation: 'spin 0.9s linear infinite',
                    }} />
                  </div>
                )}

                {/* Review Defaults */}
                <div style={{
                  padding: 'var(--space-3)',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-muted)',
                  borderRadius: 'var(--radius-md)',
                  display: 'grid',
                  gap: 'var(--space-3)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
                      Review defaults
                    </div>
                    {renderSectionInfoButton('defaults')}
                  </div>
                  {renderSectionHints('defaults')}
                  <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', opacity: controlsDisabled ? 0.6 : 1 }}>
                    <input
                      type="checkbox"
                      checked={editorDefaults.requireEvidence !== false}
                      onChange={(e) => handleRequireEvidenceToggle(e.target.checked)}
                      disabled={controlsDisabled}
                      style={{ accentColor: 'var(--accent-blue)', width: 14, height: 14 }}
                    />
                    Require evidence for findings
                  </label>
                  <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', opacity: controlsDisabled ? 0.6 : 1 }}>
                    <input
                      type="checkbox"
                      checked={editorDefaults.allowPraise === true}
                      onChange={(e) => handleAllowPraiseToggle(e.target.checked)}
                      disabled={controlsDisabled}
                      style={{ accentColor: 'var(--accent-blue)', width: 14, height: 14 }}
                    />
                    Allow praise-only comments
                  </label>
                  <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', opacity: controlsDisabled ? 0.6 : 1 }}>
                    <input
                      type="checkbox"
                      checked={editorDefaults.skipAllStructuralFiles === true}
                      onChange={(e) => handleSkipAllStructuralFilesToggle(e.target.checked)}
                      disabled={controlsDisabled}
                      style={{ accentColor: 'var(--accent-blue)', width: 14, height: 14 }}
                    />
                    Always skip structural files (scenes, prefabs, manifests, etc.)
                  </label>
                  <label
                    title={editorDefaults.skipAllStructuralFiles === true
                      ? 'Disabled — "Always skip structural files" already covers every review.'
                      : undefined}
                    style={{
                      display: 'flex',
                      gap: 'var(--space-2)',
                      alignItems: 'center',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-tertiary)',
                      opacity: (controlsDisabled || editorDefaults.skipAllStructuralFiles === true) ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={editorDefaults.largeReviewStructuralSkip !== false}
                      onChange={(e) => handleLargeReviewStructuralSkipToggle(e.target.checked)}
                      disabled={controlsDisabled || editorDefaults.skipAllStructuralFiles === true}
                      style={{ accentColor: 'var(--accent-blue)', width: 14, height: 14 }}
                    />
                    Skip structural files on large reviews (≥100 files)
                  </label>
                  <label style={{ display: 'grid', gap: 4, maxWidth: 220, opacity: controlsDisabled ? 0.6 : 1 }}>
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                      Max recommendations
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={editorDefaults.maxRecommendations ?? ''}
                      onChange={(e) => handleMaxRecommendationsChange(e.target.value)}
                      disabled={controlsDisabled}
                      placeholder="No limit"
                      style={{ ...inputStyle, maxWidth: 220 }}
                    />
                  </label>
                </div>

                {/* Prompt Guidance */}
                <div style={{
                  padding: 'var(--space-3)',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-muted)',
                  borderRadius: 'var(--radius-md)',
                  display: 'grid',
                  gap: 'var(--space-3)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-2)' }}>
                    <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
                          Prompt guidance
                        </div>
                        {renderSectionInfoButton('prompt')}
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                        Custom instructions injected into every review prompt for this project.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowTemplatesPopup(true)}
                      disabled={controlsDisabled}
                      style={{
                        ...btnSecondary,
                        padding: '4px 10px',
                        fontSize: 'var(--text-xs)',
                        flexShrink: 0,
                        opacity: controlsDisabled ? 0.5 : 1,
                      }}
                    >
                      Templates
                    </button>
                  </div>
                  {renderSectionHints('prompt')}

                  {editorPromptAppend.length > 0 && (
                    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                      {editorPromptAppend.map((entry, index) => (
                        <div
                          key={index}
                          style={{
                            display: 'flex',
                            gap: 'var(--space-2)',
                            alignItems: 'flex-start',
                            padding: 'var(--space-2)',
                            background: 'rgba(255, 255, 255, 0.03)',
                            border: '1px solid var(--border-muted)',
                            borderRadius: 'var(--radius-md)',
                          }}
                        >
                          <textarea
                            value={entry}
                            onChange={(e) => handleEditPromptGuidance(index, e.target.value)}
                            disabled={controlsDisabled}
                            rows={2}
                            style={{
                              ...inputStyle,
                              flex: 1,
                              resize: 'vertical',
                              fontSize: 'var(--text-xs)',
                              lineHeight: 1.6,
                              opacity: controlsDisabled ? 0.5 : 1,
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => handleRemovePromptGuidance(index)}
                            disabled={controlsDisabled}
                            title="Remove this guidance entry"
                            style={{
                              ...btnSecondary,
                              padding: '4px 8px',
                              fontSize: 'var(--text-xs)',
                              flexShrink: 0,
                              opacity: controlsDisabled ? 0.5 : 1,
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end' }}>
                    <textarea
                      value={newPromptGuidance}
                      onChange={(e) => setNewPromptGuidance(e.target.value)}
                      disabled={controlsDisabled}
                      rows={2}
                      placeholder="e.g. Treat auth, billing, and data-deletion flows as high risk. Call out missing permission checks and rollback gaps."
                      style={{
                        ...inputStyle,
                        flex: 1,
                        resize: 'vertical',
                        fontSize: 'var(--text-xs)',
                        lineHeight: 1.6,
                        opacity: controlsDisabled ? 0.5 : 1,
                      }}
                    />
                    <button
                      type="button"
                      onClick={handleAddPromptGuidance}
                      disabled={controlsDisabled || !newPromptGuidance.trim()}
                      style={{
                        ...btnSecondary,
                        padding: '7px 14px',
                        fontSize: 'var(--text-xs)',
                        flexShrink: 0,
                        opacity: controlsDisabled || !newPromptGuidance.trim() ? 0.5 : 1,
                      }}
                    >
                      Add
                    </button>
                  </div>
                </div>

                {/* Linter Tools */}
                <div style={{
                  padding: 'var(--space-3)',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-muted)',
                  borderRadius: 'var(--radius-md)',
                  display: 'grid',
                  gap: 'var(--space-3)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => setLinterToolsExpanded((current) => !current)}
                      aria-expanded={linterToolsExpanded}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-2)',
                        background: 'transparent',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        color: 'inherit',
                        textAlign: 'left',
                        minWidth: 0,
                        flex: '1 1 auto',
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="none"
                        aria-hidden="true"
                        style={{
                          flexShrink: 0,
                          color: 'var(--text-tertiary)',
                          transform: linterToolsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                          transition: 'transform var(--transition-fast)',
                        }}
                      >
                        <path
                          d="M4 6L8 10L12 6"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
                            Linter tools
                          </div>
                          {renderSectionInfoButton('linters')}
                        </div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                          Run static analyzers before AI review.
                        </div>
                      </div>
                    </button>
                    <label
                      onClick={(e) => e.stopPropagation()}
                      style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', opacity: controlsDisabled ? 0.6 : 1 }}
                    >
                      <input
                        type="checkbox"
                        checked={resolvedGlobalLintersEnabled}
                        onChange={(e) => handleGlobalLinterToggle(e.target.checked)}
                        disabled={controlsDisabled}
                        style={{ accentColor: 'var(--accent-blue)', width: 14, height: 14 }}
                      />
                      Enable linter pre-pass
                    </label>
                  </div>

                  {linterToolsExpanded && renderSectionHints('linters')}

                  {linterToolsExpanded && (
                  <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                    {REVIEW_POLICY_LINTER_ORDER.map((linterId) => {
                      const status = linterStatus[linterId] || {
                        policyDefaultEligible: false,
                        runtimeReady: false,
                        atlasManagedEligible: false,
                        effectiveMode: 'unavailable',
                        hasConfig: false,
                        hasBinary: null,
                        configLabel: null,
                        binaryLabel: null,
                      };
                      const explicitToolPolicy = editorLinterPolicy?.[linterId];
                      const starterToolPolicy = starterLinterPolicy?.[linterId];
                      const toolEnabled = explicitToolPolicy?.enabled !== undefined
                        ? explicitToolPolicy.enabled !== false
                        : useStarterLinterFallbacks && starterToolPolicy?.enabled !== undefined
                          ? starterToolPolicy.enabled !== false
                          : false;
                      const statusLabel = status.effectiveMode === 'project_linter'
                        ? 'Found in project'
                        : status.effectiveMode === 'atlas_managed'
                          ? 'Atlas fallback'
                          : status.hasConfig
                            ? 'Configured but not available on this machine'
                            : 'Not available';
                      const disabledForAvailability = status.effectiveMode === 'unavailable';
                      const renderedToolEnabled = disabledForAvailability ? false : toolEnabled;
                      const enableHint = status.hasConfig && status.hasBinary === false
                        ? `${REVIEW_POLICY_LINTER_LABELS[linterId]} is configured in this project, but the tool is not installed on this machine.`
                        : REVIEW_POLICY_LINTER_ENABLE_HINTS[linterId];
                      return (
                        <div
                          key={linterId}
                          style={{
                            padding: 'var(--space-2) var(--space-3)',
                            border: '1px solid var(--border-muted)',
                            borderRadius: 'var(--radius-md)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: 'var(--space-3)',
                            alignItems: 'center',
                          }}
                        >
                          <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
                              {REVIEW_POLICY_LINTER_LABELS[linterId]}
                            </div>
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                              {statusLabel}
                            </div>
                          </div>
                          <label
                            title={disabledForAvailability ? enableHint : undefined}
                            style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', flexShrink: 0, opacity: controlsDisabled || !resolvedGlobalLintersEnabled || disabledForAvailability ? 0.6 : 1 }}
                          >
                            <input
                              type="checkbox"
                              checked={renderedToolEnabled}
                              onChange={(e) => handleToolLinterToggle(linterId, e.target.checked)}
                              disabled={controlsDisabled || !resolvedGlobalLintersEnabled || disabledForAvailability}
                              title={disabledForAvailability ? enableHint : undefined}
                              style={{ accentColor: 'var(--accent-blue)', width: 14, height: 14 }}
                            />
                            Enabled
                          </label>
                        </div>
                      );
                    })}
                  </div>
                  )}
                </div>

                {/* Path Rules */}
                <div style={{
                  padding: 'var(--space-3)',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-muted)',
                  borderRadius: 'var(--radius-md)',
                  display: 'grid',
                  gap: 'var(--space-3)',
                }}>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Path rules
                      </div>
                      {renderSectionInfoButton('paths')}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                      Control review depth per file pattern. First matching rule wins.
                    </div>
                  </div>

                  {renderSectionHints('paths')}

                  {editorPaths.length > 0 && (
                    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                      {editorPaths.map((rule, index) => (
                        <div
                          key={index}
                          style={{
                            border: '1px solid var(--border-muted)',
                            borderRadius: 'var(--radius-md)',
                            overflow: 'hidden',
                          }}
                        >
                          {/* Compact row */}
                          <div style={{
                            padding: 'var(--space-2) var(--space-3)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 'var(--space-2)',
                          }}>
                            <code style={{
                              flex: 1,
                              fontSize: 'var(--text-xs)',
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              minWidth: 0,
                            }}>
                              {rule.glob}
                            </code>
                            <select
                              value={rule.fileClass || ''}
                              onChange={(e) => handleEditPathFileClass(index, e.target.value)}
                              disabled={controlsDisabled}
                              style={{
                                ...selectStyle,
                                width: 'auto',
                                minWidth: 110,
                                padding: '3px 6px',
                                fontSize: 'var(--text-xs)',
                                opacity: controlsDisabled ? 0.5 : 1,
                              }}
                            >
                              <option value="" disabled>Class...</option>
                              {REVIEW_POLICY_FILE_CLASSES.map((fc) => (
                                <option key={fc} value={fc}>{FILE_CLASS_LABELS[fc]}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => setExpandedPathIndex(expandedPathIndex === index ? null : index)}
                              disabled={controlsDisabled}
                              title={expandedPathIndex === index ? 'Collapse' : 'Edit instructions'}
                              style={{
                                ...btnSecondary,
                                padding: '3px 8px',
                                fontSize: 'var(--text-xs)',
                                flexShrink: 0,
                                opacity: controlsDisabled ? 0.5 : 1,
                              }}
                            >
                              {expandedPathIndex === index ? 'Less' : 'Edit'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemovePathRule(index)}
                              disabled={controlsDisabled}
                              title="Remove this path rule"
                              style={{
                                ...btnSecondary,
                                padding: '3px 8px',
                                fontSize: 'var(--text-xs)',
                                flexShrink: 0,
                                color: 'var(--status-error, #ef4444)',
                                opacity: controlsDisabled ? 0.5 : 0.8,
                              }}
                            >
                              Remove
                            </button>
                          </div>

                          {/* Expanded detail */}
                          {expandedPathIndex === index && (
                            <div style={{
                              padding: '0 var(--space-3) var(--space-2)',
                              display: 'grid',
                              gap: 'var(--space-2)',
                              borderTop: '1px solid var(--border-muted)',
                              paddingTop: 'var(--space-2)',
                            }}>
                              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                                {rule.fileClass ? FILE_CLASS_DESCRIPTIONS[rule.fileClass as ReviewPolicyFileClass] || '' : 'No review class set'}
                              </div>
                              <label style={{ display: 'grid', gap: 4 }}>
                                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                                  Per-path review instructions
                                </span>
                                <textarea
                                  value={rule.promptAppend || ''}
                                  onChange={(e) => handleEditPathPromptAppend(index, e.target.value)}
                                  disabled={controlsDisabled}
                                  rows={2}
                                  placeholder="e.g. Check migration safety and backward compatibility."
                                  style={{
                                    ...inputStyle,
                                    resize: 'vertical',
                                    fontSize: 'var(--text-xs)',
                                    lineHeight: 1.6,
                                    opacity: controlsDisabled ? 0.5 : 1,
                                  }}
                                />
                              </label>
                              {Array.isArray(rule.mustCheckRules) && rule.mustCheckRules.length > 0 && (
                                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                                  Must-check rules: {rule.mustCheckRules.join(', ')}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {editorPaths.length === 0 && (
                    <div style={{
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-tertiary)',
                      padding: 'var(--space-2)',
                      textAlign: 'center',
                      opacity: 0.7,
                    }}>
                      No custom path rules. Atlas auto-detects common patterns (tests, lock files, build output).
                    </div>
                  )}

                  {/* Add new path rule */}
                  <div style={{
                    padding: 'var(--space-2)',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid var(--border-muted)',
                    borderRadius: 'var(--radius-md)',
                    display: 'grid',
                    gap: 'var(--space-2)',
                  }}>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end' }}>
                      <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                          Glob pattern
                        </span>
                        <div style={{ position: 'relative' }}>
                          <input
                            type="text"
                            value={newPathGlob}
                            onChange={(e) => setNewPathGlob(e.target.value)}
                            disabled={controlsDisabled}
                            placeholder="e.g. **/*.test.ts, **/migrations/**"
                            style={{
                              ...inputStyle,
                              fontSize: 'var(--text-xs)',
                              paddingRight: 34,
                              opacity: controlsDisabled ? 0.5 : 1,
                            }}
                          />
                          {(isTauriEnvironment() || typeof (window as any).showDirectoryPicker === 'function') && (
                            <button
                              type="button"
                              onClick={handleBrowseFolder}
                              disabled={controlsDisabled}
                              title="Browse folder"
                              style={{
                                position: 'absolute',
                                right: 4,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                background: 'none',
                                border: 'none',
                                cursor: controlsDisabled ? 'default' : 'pointer',
                                padding: '4px 6px',
                                color: 'var(--text-tertiary)',
                                opacity: controlsDisabled ? 0.4 : 0.8,
                                fontSize: 14,
                                lineHeight: 1,
                                borderRadius: 4,
                                transition: 'color 0.15s, opacity 0.15s',
                              }}
                              onMouseEnter={(e) => { if (!controlsDisabled) { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--accent-blue)'; } }}
                              onMouseLeave={(e) => { if (!controlsDisabled) { e.currentTarget.style.opacity = '0.8'; e.currentTarget.style.color = 'var(--text-tertiary)'; } }}
                            >
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2 3.5h4.5l1.5 1.5H14v8H2z" />
                                <path d="M2 3.5V13" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </label>
                      <label style={{ display: 'grid', gap: 4, flexShrink: 0 }}>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                          Review depth
                        </span>
                        <select
                          value={newPathFileClass}
                          onChange={(e) => setNewPathFileClass(e.target.value as ReviewPolicyFileClass)}
                          disabled={controlsDisabled}
                          style={{
                            ...selectStyle,
                            width: 'auto',
                            minWidth: 110,
                            fontSize: 'var(--text-xs)',
                            opacity: controlsDisabled ? 0.5 : 1,
                          }}
                        >
                          {REVIEW_POLICY_FILE_CLASSES.map((fc) => (
                            <option key={fc} value={fc}>{FILE_CLASS_LABELS[fc]} — {FILE_CLASS_DESCRIPTIONS[fc]}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end' }}>
                      <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                          Per-path instructions <span style={{ opacity: 0.5 }}>(optional)</span>
                        </span>
                        <input
                          type="text"
                          value={newPathPromptAppend}
                          onChange={(e) => setNewPathPromptAppend(e.target.value)}
                          disabled={controlsDisabled}
                          placeholder="e.g. Check migration safety and backward compatibility."
                          style={{
                            ...inputStyle,
                            fontSize: 'var(--text-xs)',
                            opacity: controlsDisabled ? 0.5 : 1,
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={handleAddPathRule}
                        disabled={controlsDisabled || !newPathGlob.trim()}
                        style={{
                          ...btnSecondary,
                          padding: '7px 14px',
                          fontSize: 'var(--text-xs)',
                          flexShrink: 0,
                          opacity: controlsDisabled || !newPathGlob.trim() ? 0.5 : 1,
                        }}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── JSON Tab ── */}
            {policyEditorTab === 'json' && (
              <div style={{ position: 'relative', marginBottom: 'var(--space-3)' }}>
                <div
                  style={{
                    background: 'var(--review-code-bg)',
                    border: '1px solid var(--review-shell-border)',
                    borderRadius: 'var(--radius-md)',
                    overflow: 'hidden',
                    minHeight: 320,
                    height: 'max(420px, calc(100vh - 470px))',
                    opacity: loadingPolicy && selectedProjectId ? 0.18 : loading || !selectedProjectId ? 0.6 : 1,
                  }}
                >
                  <CodeEditor
                    value={content}
                    onChange={setContent}
                    language="json"
                    readOnly={loading || saving || !selectedProjectId}
                  />
                </div>
                {loadingPolicy && selectedProjectId && (
                  <div style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(10, 15, 26, 0.72)',
                    borderRadius: 'var(--radius-md)',
                    pointerEvents: 'none',
                  }}>
                    <div style={{
                      display: 'grid', gap: 6, justifyItems: 'center', textAlign: 'center',
                    }}>
                      <div style={{
                        width: 18, height: 18, borderRadius: 999,
                        border: '2px solid rgba(148, 163, 184, 0.28)',
                        borderTopColor: 'var(--accent-blue)',
                        animation: 'spin 0.9s linear infinite',
                      }} />
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Loading policy...
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Shared action buttons ── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                {!fileExists && selectedProjectId ? 'No policy file saved yet — Atlas uses built-in defaults.' : '\u00A0'}
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={handleReload}
                  disabled={loading || saving || !selectedProjectId}
                  style={{ ...btnSecondary, opacity: loading || saving || !selectedProjectId ? 0.5 : 1 }}
                >
                  Reload
                </button>
                {fileExists && (
                  <button
                    type="button"
                    onClick={() => setContent(defaultContent)}
                    disabled={loading || saving || !selectedProjectId || !canPreviewStarter}
                    style={{ ...btnSecondary, opacity: loading || saving || !selectedProjectId || !canPreviewStarter ? 0.5 : 1 }}
                  >
                    Reset to starter
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { void handleSave(); }}
                  disabled={saveDisabled}
                  style={{ ...btnPrimary, opacity: saveDisabled ? 0.5 : 1 }}
                >
                  {saveButtonLabel}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ---- CodeGraph (per project) ---- */}
      <div style={subsectionLabelStyle}>CodeGraph (experimental)</div>
      <div style={cardStyle}>
        <CodegraphSection />
      </div>

      {showTemplatesPopup && (
        <div
          onClick={() => setShowTemplatesPopup(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10001,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            background: 'rgba(10, 15, 26, 0.62)',
            backdropFilter: 'blur(6px)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 660,
              maxWidth: 'min(660px, 92vw)',
              maxHeight: '80vh',
              background: 'var(--review-shell-bg)',
              border: '1px solid var(--review-shell-border-strong)',
              borderRadius: 18,
              boxShadow: 'var(--review-panel-shadow)',
              display: 'grid',
              gridTemplateRows: 'auto minmax(0, 1fr)',
              overflow: 'hidden',
            }}
          >
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              alignItems: 'center',
              padding: 'var(--space-4) var(--space-5)',
              borderBottom: '1px solid var(--border-muted)',
            }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>
                Prompt & rule templates
              </div>
              <button
                type="button"
                onClick={() => setShowTemplatesPopup(false)}
                style={{ ...btnSecondary, padding: '4px 10px', flexShrink: 0, fontSize: 'var(--text-xs)' }}
              >
                Close
              </button>
            </div>

            <div style={{
              overflow: 'auto',
              padding: 'var(--space-4) var(--space-5)',
              display: 'grid',
              gap: 'var(--space-3)',
            }}>
              {REVIEW_POLICY_EXAMPLES.map((example) => (
                <div
                  key={example.id}
                  style={{
                    padding: 'var(--space-3)',
                    background: 'var(--bg-base)',
                    border: '1px solid var(--border-muted)',
                    borderRadius: 'var(--radius-md)',
                    display: 'grid',
                    gap: 'var(--space-2)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {example.label}
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                        {example.description}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => { handleApplyExample(example.snippet); setShowTemplatesPopup(false); }}
                      disabled={loading || saving || !selectedProjectId}
                      style={{ ...btnSecondary, padding: '4px 10px', fontSize: 'var(--text-xs)', opacity: loading || saving || !selectedProjectId ? 0.5 : 1, flexShrink: 0 }}
                    >
                      Apply
                    </button>
                  </div>
                  <pre style={{
                    margin: 0,
                    padding: 'var(--space-2)',
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid var(--border-muted)',
                    borderRadius: 'var(--radius-md)',
                    overflowX: 'auto',
                    fontSize: 10,
                    lineHeight: 1.5,
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                    maxHeight: 120,
                  }}
                  >
                    {JSON.stringify(example.snippet, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Git Section
// ---------------------------------------------------------------------------

const POLL_INTERVAL_OPTIONS = [
  { value: '2', label: '2 seconds' },
  { value: '5', label: '5 seconds' },
  { value: '10', label: '10 seconds' },
  { value: '30', label: '30 seconds' },
  { value: 'manual', label: 'Manual only' },
];

const PR_REFRESH_INTERVAL_OPTIONS = [
  { value: '30', label: '30 seconds' },
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
  { value: 'manual', label: 'Manual only' },
];

const DEFAULT_IGNORED_BRANCHES = ['gh-pages', 'release/*'];

function GitSection() {
  const {
    enabled: prAutoRefreshEnabled,
    interval: prAutoRefreshInterval,
    loading: prAutoRefreshLoading,
    setEnabled: setPrAutoRefreshEnabled,
    setIntervalValue: setPrAutoRefreshInterval,
  } = usePrAutoRefreshSettings();

  const [pollInterval, setPollInterval] = useState('5');

  // Ignored Branches
  const [ignoredBranches, setIgnoredBranches] = useState<string>(DEFAULT_IGNORED_BRANCHES.join('\n'));
  const ignoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadGitSettings();
    return () => {
      if (ignoreTimerRef.current) clearTimeout(ignoreTimerRef.current);
    };
  }, []);

  const loadGitSettings = async () => {
    try {
      const results = await Promise.allSettled([
        settingsApi.get('git_poll_interval'),
        settingsApi.get('git_ignored_branches'),
      ]);

      const val = (idx: number) => {
        const r = results[idx];
        return r.status === 'fulfilled' && r.value.exists && r.value.value != null ? r.value.value : null;
      };

      const v0 = val(0); if (v0 !== null) setPollInterval(v0);
      const v1 = val(1);
      if (v1 !== null) {
        try {
          const parsed = JSON.parse(v1);
          if (Array.isArray(parsed)) setIgnoredBranches(parsed.join('\n'));
        } catch { /* use defaults */ }
      }
    } catch {
      // Use defaults
    } finally {
      setLoading(false);
    }
  };

  // -- Watcher handlers --

  const handlePollIntervalChange = useCallback(async (value: string) => {
    setPollInterval(value);
    try { await settingsApi.set('git_poll_interval', value); }
    catch { toast.error('Failed to save setting'); }
  }, []);

  const handlePrAutoRefreshToggle = useCallback(async () => {
    const nextValue = !prAutoRefreshEnabled;
    try {
      await setPrAutoRefreshEnabled(nextValue);
    } catch {
      toast.error('Failed to save PR auto-refresh setting');
    }
  }, [prAutoRefreshEnabled, setPrAutoRefreshEnabled]);

  const handlePrAutoRefreshIntervalChange = useCallback(async (value: string) => {
    try {
      await setPrAutoRefreshInterval(value);
    } catch {
      toast.error('Failed to save PR auto-refresh interval');
    }
  }, [setPrAutoRefreshInterval]);

  // -- Ignored Branches handlers --

  const handleIgnoredBranchesChange = useCallback((value: string) => {
    setIgnoredBranches(value);
    if (ignoreTimerRef.current) clearTimeout(ignoreTimerRef.current);
    ignoreTimerRef.current = setTimeout(async () => {
      const lines = value.split('\n').map((l) => l.trim()).filter(Boolean);
      try {
        await settingsApi.set('git_ignored_branches', JSON.stringify(lines));
      } catch {
        toast.error('Failed to save ignored branches');
      }
    }, 500);
  }, []);

  const handleAddBranchPattern = useCallback(() => {
    const newVal = ignoredBranches.endsWith('\n') ? ignoredBranches : ignoredBranches + '\n';
    setIgnoredBranches(newVal);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = textareaRef.current.value.length;
        textareaRef.current.selectionEnd = textareaRef.current.value.length;
      }
    }, 0);
  }, [ignoredBranches]);

  return (
    <div>
      {/* ---- Watcher ---- */}
      <div style={subsectionLabelStyle}>Watcher</div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
              Poll interval
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
              How often Atlas polls local git state for new commits and branch updates.
            </div>
          </div>
          <select
            value={pollInterval}
            onChange={(e) => handlePollIntervalChange(e.target.value)}
            disabled={loading}
            style={{ ...selectStyle, maxWidth: 180, opacity: loading ? 0.5 : 1 }}
          >
            {POLL_INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ---- Pull Requests ---- */}
      <div style={subsectionLabelStyle}>Pull Requests</div>
      <div style={cardStyle}>
        <ToggleRow
          label="Background refresh pull requests"
          value={prAutoRefreshEnabled}
          onChange={handlePrAutoRefreshToggle}
          disabled={prAutoRefreshLoading}
        />
        <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border-muted)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
                Refresh interval
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
                Atlas syncs pull requests once when a project opens. Manual only disables recurring background GitHub polling after that.
              </div>
            </div>
            <select
              value={prAutoRefreshInterval}
              onChange={(event) => handlePrAutoRefreshIntervalChange(event.target.value)}
              disabled={prAutoRefreshLoading}
              style={{ ...selectStyle, maxWidth: 180, opacity: prAutoRefreshLoading ? 0.5 : 1 }}
            >
              {PR_REFRESH_INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ---- Ignored Branches ---- */}
      <div style={subsectionLabelStyle}>Ignored Branches</div>
      <div style={cardStyle}>
        <textarea
          ref={textareaRef}
          value={ignoredBranches}
          onChange={(e) => handleIgnoredBranchesChange(e.target.value)}
          disabled={loading}
          rows={4}
          style={{
            ...inputStyle,
            resize: 'vertical',
            lineHeight: 1.6,
            opacity: loading ? 0.5 : 1,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-2)' }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            Branch name patterns. One per line.
          </div>
          <button
            type="button"
            onClick={handleAddBranchPattern}
            disabled={loading}
            style={{ ...btnSecondary, opacity: loading ? 0.5 : 1 }}
          >
            + Add branch pattern
          </button>
        </div>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub Section
// ---------------------------------------------------------------------------

function GitHubSection() {
  return (
    <div>
      <div style={subsectionLabelStyle}>GitHub Accounts</div>
      <GitHubConnect />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verify Section
// ---------------------------------------------------------------------------

interface CheckConfig {
  id: string;
  label: string;
  kind: VerifyCheckConfig['kind'];
  command: string;
  enabled: boolean;
  isCustom?: boolean;
}

const VERIFY_CHECK_KINDS: VerifyCheckConfig['kind'][] = ['lint', 'typecheck', 'build', 'unit', 'integration', 'e2e', 'custom'];

function normalizeVerifyCheckKind(kind: string): VerifyCheckConfig['kind'] {
  return VERIFY_CHECK_KINDS.includes(kind as VerifyCheckConfig['kind'])
    ? kind as VerifyCheckConfig['kind']
    : 'custom';
}

const AUTO_RUN_OPTIONS = [
  { value: 'never', label: 'Never' },
  { value: 'on_changeset', label: 'On changeset creation' },
];

function VerifySection() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [checks, setChecks] = useState<CheckConfig[]>([]);
  const [autoRun, setAutoRun] = useState<'never' | 'on_changeset'>('on_changeset');
  const [projectType, setProjectType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Counter for generating unique IDs for custom checks
  const customIdCounter = useRef(0);

  useEffect(() => {
    const loadProjects = async () => {
      setLoading(true);
      try {
        const result = await projectApi.list();
        setProjects(result.projects);
        if (result.projects.length > 0) {
          setSelectedProjectId((prev) => prev || result.projects[0].id);
        } else {
          setSelectedProjectId('');
          setChecks([]);
          setProjectType(null);
          setAutoRun('on_changeset');
        }
      } catch {
        toast.error('Failed to load projects');
      } finally {
        setLoading(false);
      }
    };
    void loadProjects();
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setChecks([]);
      setProjectType(null);
      setAutoRun('on_changeset');
      return;
    }
    void loadVerifySettings(selectedProjectId);
  }, [selectedProjectId]);

  const loadVerifySettings = async (projectId: string) => {
    setLoading(true);
    try {
      const config = await changesetApi.getVerifyConfig(projectId);
      const normalizedChecks = Array.isArray(config.checks) && config.checks.length > 0
        ? config.checks.map((check) => ({
          id: check.id,
          label: check.label,
          kind: normalizeVerifyCheckKind(check.kind),
          command: check.command,
          enabled: check.enabled,
          isCustom: check.source === 'custom' || check.kind === 'custom',
        }))
        : [];
      setChecks(normalizedChecks);
      setAutoRun(config.autoRun === 'never' ? 'never' : 'on_changeset');
      setProjectType(config.projectType || null);
      const maxCustomNum = normalizedChecks
        .filter((check) => check.isCustom && check.id.startsWith('custom_'))
        .map((check) => parseInt(check.id.replace('custom_', ''), 10))
        .filter((value) => !isNaN(value));
      if (maxCustomNum.length > 0) {
        customIdCounter.current = Math.max(...maxCustomNum) + 1;
      }
    } catch {
      toast.error('Failed to load project verify settings');
    } finally {
      setLoading(false);
    }
  };

  const persistChecks = useCallback(async (updated: CheckConfig[]) => {
    if (!selectedProjectId) return;
    try {
      const payload: Partial<VerifyConfig> = {
        autoRun,
        checks: updated.map((check) => ({
          id: check.id,
          label: check.label,
          kind: check.kind,
          command: check.command,
          enabled: check.enabled,
          source: check.isCustom ? 'custom' : 'detected',
        })),
      };
      await changesetApi.updateVerifyConfig(selectedProjectId, payload);
    } catch {
      toast.error('Failed to save check configuration');
    }
  }, [autoRun, selectedProjectId]);

  const handleCheckToggle = useCallback((id: string) => {
    setChecks((prev) => {
      const updated = prev.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c));
      persistChecks(updated);
      return updated;
    });
  }, [persistChecks]);

  const handleCheckCommandChange = useCallback((id: string, command: string) => {
    setChecks((prev) => {
      const updated = prev.map((c) => (c.id === id ? { ...c, command } : c));
      persistChecks(updated);
      return updated;
    });
  }, [persistChecks]);

  const handleCheckLabelChange = useCallback((id: string, label: string) => {
    setChecks((prev) => {
      const updated = prev.map((c) => (c.id === id ? { ...c, label } : c));
      persistChecks(updated);
      return updated;
    });
  }, [persistChecks]);

  const handleAddCustomCheck = useCallback(() => {
    const id = `custom_${customIdCounter.current++}`;
    setChecks((prev) => {
      const newCheck: CheckConfig = {
        id,
        label: 'Custom Check',
        kind: 'custom',
        command: '',
        enabled: true,
        isCustom: true,
      };
      const updated = [...prev, newCheck];
      persistChecks(updated);
      return updated;
    });
  }, [persistChecks]);

  const handleRemoveCheck = useCallback((id: string) => {
    setChecks((prev) => {
      const updated = prev.filter((c) => c.id !== id);
      persistChecks(updated);
      return updated;
    });
  }, [persistChecks]);

  const handleAutoRunChange = useCallback(async (value: 'never' | 'on_changeset') => {
    setAutoRun(value);
    if (!selectedProjectId) return;
    try {
      await changesetApi.updateVerifyConfig(selectedProjectId, { autoRun: value });
    } catch {
      toast.error('Failed to save setting');
    }
  }, [selectedProjectId]);

  return (
    <div>
      {/* ---- Check Configuration ---- */}
      <div style={subsectionLabelStyle}>Check Configuration</div>
      <div style={cardStyle}>
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-2)' }}>
            Project
          </label>
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            disabled={loading || projects.length === 0}
            style={{ ...selectStyle, width: '100%', opacity: loading ? 0.5 : 1 }}
          >
            {projects.length === 0 && <option value="">No projects found</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>
          Checks are detected per project and can be overridden here. Enabled checks are the ones Atlas runs and enforces before publish when verification gating is on.
        </div>
        {!selectedProjectId && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)' }}>
            Select a project to configure its verification checks.
          </div>
        )}
        {projectType && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 'var(--space-3)' }}>
            Detected stack: <span style={{ color: 'var(--text-primary)', textTransform: 'capitalize' }}>{projectType}</span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {selectedProjectId && checks.length === 0 && (
            <div style={{
              padding: 'var(--space-3)',
              background: 'var(--bg-base)',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-muted)',
              fontSize: 'var(--text-xs)',
              color: 'var(--text-tertiary)',
            }}>
              No verification checks are configured for this project yet.
            </div>
          )}
          {checks.map((check) => (
            <div
              key={check.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                padding: 'var(--space-2)',
                background: 'var(--bg-base)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-muted)',
              }}
            >
              {/* Label */}
              {check.isCustom ? (
                <input
                  type="text"
                  value={check.label}
                  onChange={(e) => handleCheckLabelChange(check.id, e.target.value)}
                  disabled={loading}
                  style={{
                    ...inputStyle,
                    width: 110,
                    minWidth: 110,
                    flexShrink: 0,
                    fontSize: 'var(--text-xs)',
                    fontFamily: 'var(--font-sans)',
                    padding: '4px var(--space-2)',
                  }}
                  placeholder="Check name"
                />
              ) : (
                <div style={{
                  width: 110,
                  minWidth: 110,
                  flexShrink: 0,
                  fontSize: 'var(--text-sm)',
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                }}>
                  {check.label}
                </div>
              )}

              {!check.isCustom && (
                <div style={{
                  width: 88,
                  minWidth: 88,
                  flexShrink: 0,
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-tertiary)',
                  textTransform: 'capitalize',
                }}>
                  {check.kind}
                </div>
              )}

              {/* Command input */}
              <input
                type="text"
                value={check.command}
                onChange={(e) => handleCheckCommandChange(check.id, e.target.value)}
                disabled={loading}
                style={{
                  ...inputStyle,
                  flex: 1,
                  fontSize: 'var(--text-xs)',
                  padding: '4px var(--space-2)',
                }}
                placeholder="Command to run"
              />

              {/* Enable toggle */}
              <button
                type="button"
                onClick={() => handleCheckToggle(check.id)}
                disabled={loading}
                style={{
                  position: 'relative',
                  width: 36,
                  height: 20,
                  borderRadius: 10,
                  border: 'none',
                  background: check.enabled ? 'var(--accent-blue)' : 'var(--bg-hover)',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.5 : 1,
                  transition: 'background var(--transition-fast)',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: check.enabled ? 18 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left var(--transition-fast)',
                  }}
                />
              </button>

              {/* Remove button for custom checks */}
              {check.isCustom && (
                <button
                  type="button"
                  onClick={() => handleRemoveCheck(check.id)}
                  title="Remove check"
                  style={{
                    ...btnBase,
                    background: 'transparent',
                    color: 'var(--text-tertiary)',
                    padding: '2px',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--status-error, #ef4444)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
                >
                  <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 'var(--space-3)' }}>
          <button
            type="button"
            onClick={handleAddCustomCheck}
            disabled={loading || !selectedProjectId}
            style={{ ...btnSecondary, opacity: loading || !selectedProjectId ? 0.5 : 1 }}
          >
            + Add Custom Check
          </button>
        </div>
      </div>

      {/* ---- Auto-Run ---- */}
      <div style={subsectionLabelStyle}>Auto-Run</div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
              Run checks automatically
            </div>
          </div>
          <select
            value={autoRun}
            onChange={(e) => handleAutoRunChange(e.target.value as 'never' | 'on_changeset')}
            disabled={loading || !selectedProjectId}
            style={{ ...selectStyle, maxWidth: 200, opacity: loading || !selectedProjectId ? 0.5 : 1 }}
          >
            {AUTO_RUN_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 'var(--space-3)', paddingTop: 'var(--space-2)', borderTop: '1px solid var(--border-muted)' }}>
          Auto-run currently supports running enabled checks when a changeset is created. Leave it on `Never` for slower projects.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// General Section
// ---------------------------------------------------------------------------

const isTauri = isTauriEnvironment();

function GeneralSection() {
  // Default tab
  const [defaultTab, setDefaultTab] = useState<string>('trust-pipeline');
  const [loadingDefaultTab, setLoadingDefaultTab] = useState(true);

  // UI Scale
  const [uiScale, setUiScale] = useState<string>('100');
  const [loadingUiScale, setLoadingUiScale] = useState(true);

  // Keyboard shortcuts
  const [shortcutsEnabled, setShortcutsEnabled] = useState(true);
  const [showShortcutBar, setShowShortcutBar] = useState(true);
  const [loadingShortcuts, setLoadingShortcuts] = useState(true);

  // Data
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showRemoveIntegrationsConfirm, setShowRemoveIntegrationsConfirm] = useState(false);
  const [removingIntegrations, setRemovingIntegrations] = useState(false);

  // Sign out
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const [tabResult, shortcutsResult, barResult, scaleResult] = await Promise.allSettled([
        settingsApi.get('default_tab'),
        settingsApi.get('keyboard_shortcuts_enabled'),
        settingsApi.get('show_shortcut_bar'),
        settingsApi.get('ui_scale'),
      ]);

      if (tabResult.status === 'fulfilled' && tabResult.value.exists && tabResult.value.value) {
        setDefaultTab(tabResult.value.value);
      } else {
        // Fall back to localStorage
        const stored = localStorage.getItem('atlas_active_tab');
        if (stored === 'trust-pipeline' || stored === 'atlas-builder') {
          setDefaultTab(stored);
        }
      }

      if (shortcutsResult.status === 'fulfilled' && shortcutsResult.value.exists && shortcutsResult.value.value !== null) {
        setShortcutsEnabled(shortcutsResult.value.value !== 'false');
      }

      if (barResult.status === 'fulfilled' && barResult.value.exists && barResult.value.value !== null) {
        setShowShortcutBar(barResult.value.value !== 'false');
      }

      if (scaleResult.status === 'fulfilled' && scaleResult.value.exists && scaleResult.value.value) {
        setUiScale(scaleResult.value.value);
      }
    } catch {
      // Use defaults
    } finally {
      setLoadingDefaultTab(false);
      setLoadingUiScale(false);
      setLoadingShortcuts(false);
    }
  };

  const handleDefaultTabChange = useCallback(async (value: string) => {
    setDefaultTab(value);
    // Update localStorage so TrustPipelineShell picks it up immediately
    localStorage.setItem('atlas_active_tab', value);
    try {
      await settingsApi.set('default_tab', value);
    } catch {
      toast.error('Failed to save setting');
    }
  }, []);

  const handleUiScaleChange = useCallback(async (value: string) => {
    setUiScale(value);
    applyFontScale(Number(value));
    try {
      await settingsApi.set('ui_scale', value);
    } catch {
      toast.error('Failed to save setting');
    }
  }, []);

  const handleShortcutsToggle = useCallback(async () => {
    const newValue = !shortcutsEnabled;
    setShortcutsEnabled(newValue);
    try {
      await settingsApi.set('keyboard_shortcuts_enabled', String(newValue));
    } catch {
      setShortcutsEnabled(!newValue);
      toast.error('Failed to save setting');
    }
  }, [shortcutsEnabled]);

  const handleShortcutBarToggle = useCallback(async () => {
    const newValue = !showShortcutBar;
    setShowShortcutBar(newValue);
    try {
      await settingsApi.set('show_shortcut_bar', String(newValue));
    } catch {
      setShowShortcutBar(!newValue);
      toast.error('Failed to save setting');
    }
  }, [showShortcutBar]);

  const handleViewShortcuts = useCallback(() => {
    // Dispatch a custom event that TrustPipelineShell's keyboard handler can pick up
    // We simulate pressing '?' to toggle the shortcut overlay
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: '?',
      bubbles: true,
    }));
  }, []);

  const handleClearAllProjects = useCallback(async () => {
    setShowClearConfirm(false);
    try {
      const result = await projectApi.list();
      let cleared = 0;
      for (const project of result.projects) {
        try {
          await projectApi.delete(project.id);
          cleared++;
        } catch {
          // Continue with others
        }
      }
      toast.success(`Cleared ${cleared} project(s)`);
    } catch {
      toast.error('Failed to clear projects');
    }
  }, []);

  const handleRemoveIntegrations = useCallback(async () => {
    setRemovingIntegrations(true);
    try {
      const response = await mcpApi.removeIntegrations({
        buildIfNeeded: true,
      });

      await settingsApi.delete(MCP_AUTO_SELECTED_AGENTS_KEY).catch(() => {});

      const changedConfigCount = response.removedResults.filter((entry) => entry.changed).length;
      const changedGuidanceCount = response.workflowGuidanceResults.filter((entry) => entry.changed).length;
      const changedCount = changedConfigCount + changedGuidanceCount;

      if (response.failures.length > 0) {
        toast.error(`Removed Atlas integrations with ${response.failures.length} issue${response.failures.length === 1 ? '' : 's'}.`);
      } else if (changedCount > 0) {
        toast.success(`Removed ${changedCount} Atlas-managed integration change${changedCount === 1 ? '' : 's'}.`);
      } else {
        toast('No Atlas-managed integrations were found to remove.', { icon: 'i' });
      }

      if (response.restartHints.length > 0) {
        const hint = response.restartHints.map((entry) => entry.hint).join(' ');
        toast(hint, { icon: 'i' });
      }
    } catch (error) {
      toast.error(describeApiError(error, 'Failed to remove Atlas integrations'));
    } finally {
      setRemovingIntegrations(false);
      setShowRemoveIntegrationsConfirm(false);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      // 1. Best-effort: preserve the previous sign-out behavior by allowing the
      // MCP setup layer to build any missing config wrapper before removal.
      await removeManagedIntegrationsForReset(true);

      // 2. Backend: clear setup state, provider cache, preferences
      await settingsApi.resetForSignout();

      // 3. Clear all localStorage keys used by the app
      localStorage.removeItem('atlas_visited');
      localStorage.removeItem('atlas_active_tab');
      localStorage.removeItem('claude_connected');
      localStorage.removeItem('auth_token');
      localStorage.removeItem('atlas_setup_providers_override');

      // 4. Quit app (Tauri) or reload (web)
      if (isTauri) {
        try {
          // Tauri v2: close the main window which exits the app
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().close();
        } catch {
          // Fallback: reload so the setup wizard shows on next manual launch
          window.location.reload();
        }
      } else {
        // Browser dev mode does not have the desktop first-run bootstrap, so
        // force the wizard on the next reload after sign-out/reset.
        localStorage.setItem('atlas_force_setup_wizard', '1');
        window.location.reload();
      }
    } catch (err) {
      console.error('Sign out failed:', err);
      toast.error('Sign out failed. Please try again.');
      setSigningOut(false);
      setShowSignOutConfirm(false);
    }
  }, []);

  const isLoading = loadingDefaultTab || loadingShortcuts;

  return (
    <div>
      {/* ---- Default Tab (only when builder is enabled) ---- */}
      {ENABLE_BUILDER && (
        <>
          <div style={subsectionLabelStyle}>Default Tab</div>
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
                  Open AtlasEngine to
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
                  Choose which tab to show when the app starts
                </div>
              </div>
              <select
                value={defaultTab}
                onChange={(e) => handleDefaultTabChange(e.target.value)}
                disabled={isLoading}
                style={{ ...selectStyle, maxWidth: 200, opacity: isLoading ? 0.5 : 1 }}
              >
                <option value="trust-pipeline">Review</option>
                <option value="atlas-builder">Build</option>
              </select>
            </div>
          </div>
        </>
      )}

      {/* ---- UI Scale ---- */}
      <div style={subsectionLabelStyle}>Display</div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
              Font Size
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
              Adjust the size of text throughout the app
            </div>
          </div>
          <select
            value={uiScale}
            onChange={(e) => handleUiScaleChange(e.target.value)}
            disabled={loadingUiScale}
            style={{ ...selectStyle, maxWidth: 120, opacity: loadingUiScale ? 0.5 : 1 }}
          >
            <option value="90">90%</option>
            <option value="100">100%</option>
            <option value="110">110%</option>
            <option value="120">120%</option>
            <option value="130">130%</option>
          </select>
        </div>
      </div>

      {/* ---- Keyboard Shortcuts ---- */}
      <div style={subsectionLabelStyle}>Keyboard Shortcuts</div>
      <div style={cardStyle}>
        <ToggleRow
          label="Enable keyboard shortcuts"
          description="Global shortcuts for navigation and actions"
          value={shortcutsEnabled}
          onChange={handleShortcutsToggle}
          disabled={isLoading}
        />
        <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border-muted)' }}>
          <ToggleRow
            label="Show shortcut bar at bottom"
            description="Display a hint bar with available shortcuts"
            value={showShortcutBar}
            onChange={handleShortcutBarToggle}
            disabled={isLoading}
          />
        </div>
        <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--border-muted)' }}>
          <button
            type="button"
            onClick={handleViewShortcuts}
            style={btnSecondary}
          >
            View All Shortcuts
          </button>
        </div>
      </div>

      {/* ---- Data ---- */}
      <div style={subsectionLabelStyle}>Data</div>
      <div style={cardStyle}>
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 2 }}>
            Database location
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            {isTauri ? DESKTOP_DATABASE_DISPLAY_PATH : 'PostgreSQL server'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            style={{ ...btnSecondary, opacity: 0.5, cursor: 'not-allowed' }}
            disabled
            title="Coming soon"
          >
            Export All Data
          </button>
          {!showClearConfirm ? (
            <button
              type="button"
              onClick={() => setShowClearConfirm(true)}
              style={{ ...btnBase, background: 'transparent', color: 'var(--status-error, #ef4444)' }}
            >
              Clear All Projects
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--status-error, #ef4444)' }}>
                Are you sure? This cannot be undone.
              </span>
              <button
                type="button"
                onClick={handleClearAllProjects}
                style={{ ...btnBase, background: 'var(--status-error, #ef4444)', color: '#fff' }}
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                style={{ ...btnSecondary }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ---- Notifications ---- */}
      <div style={subsectionLabelStyle}>Notifications</div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
              Desktop notifications
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
              Coming soon
            </div>
          </div>
          <div style={{
            padding: '2px var(--space-2)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-hover)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-tertiary)',
          }}>
            Disabled
          </div>
        </div>
      </div>

      {/* ---- Integrations ---- */}
      <div style={{ ...subsectionLabelStyle, marginTop: 'var(--space-6)' }}>Integrations</div>
      <div style={{
        ...cardStyle,
        borderColor: showRemoveIntegrationsConfirm ? 'var(--status-error, #ef4444)' : 'var(--border-default)',
      }}>
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
            Remove Atlas integrations
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
            Removes only Atlas-managed MCP entries and global guidance blocks from supported tools like Claude Code and Codex.
            This does not delete your projects, auth, prompts, or other user-owned config.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          {!showRemoveIntegrationsConfirm ? (
            <button
              type="button"
              onClick={() => setShowRemoveIntegrationsConfirm(true)}
              disabled={removingIntegrations}
              style={{ ...btnBase, background: 'transparent', color: 'var(--status-error, #ef4444)' }}
            >
              Remove Atlas integrations
            </button>
          ) : (
            <>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--status-error, #ef4444)' }}>
                {removingIntegrations ? 'Removing Atlas integrations...' : 'Only Atlas-managed MCP/global config will be removed. Continue?'}
              </span>
              <button
                type="button"
                onClick={handleRemoveIntegrations}
                disabled={removingIntegrations}
                style={{
                  ...btnBase,
                  background: 'var(--status-error, #ef4444)',
                  color: '#fff',
                  opacity: removingIntegrations ? 0.6 : 1,
                }}
              >
                {removingIntegrations ? 'Removing...' : 'Confirm Remove'}
              </button>
              {!removingIntegrations && (
                <button
                  type="button"
                  onClick={() => setShowRemoveIntegrationsConfirm(false)}
                  style={btnSecondary}
                >
                  Cancel
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* ---- Sign Out ---- */}
      <div style={{ ...subsectionLabelStyle, marginTop: 'var(--space-6)' }}>Sign Out</div>
      <div style={{
        ...cardStyle,
        borderColor: showSignOutConfirm ? 'var(--status-error, #ef4444)' : 'var(--border-default)',
      }}>
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
            Sign out and reset setup
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
            Clears detected CLI providers, setup wizard state, and cached preferences.
            The app will quit and show the initial setup on next launch.
            Your projects and database are preserved.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          {!showSignOutConfirm ? (
            <button
              type="button"
              onClick={() => setShowSignOutConfirm(true)}
              disabled={signingOut}
              style={{ ...btnBase, background: 'transparent', color: 'var(--status-error, #ef4444)' }}
            >
              Sign Out
            </button>
          ) : (
            <>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--status-error, #ef4444)' }}>
                {signingOut ? 'Signing out...' : 'The app will quit. Continue?'}
              </span>
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                style={{
                  ...btnBase,
                  background: 'var(--status-error, #ef4444)',
                  color: '#fff',
                  opacity: signingOut ? 0.6 : 1,
                }}
              >
                {signingOut ? 'Signing out...' : 'Confirm Sign Out'}
              </button>
              {!signingOut && (
                <button
                  type="button"
                  onClick={() => setShowSignOutConfirm(false)}
                  style={btnSecondary}
                >
                  Cancel
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Reusable toggle row for settings */
function ToggleRow({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
          {label}
        </div>
        {description && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
            {description}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onChange}
        disabled={disabled}
        style={{
          position: 'relative',
          width: 36,
          height: 20,
          borderRadius: 10,
          border: 'none',
          background: value ? 'var(--accent-blue)' : 'var(--bg-hover)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background var(--transition-fast)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: value ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left var(--transition-fast)',
          }}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP Section
// ---------------------------------------------------------------------------

function McpSection() {
  const [loading, setLoading] = useState(true);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [syncingStartupSelection, setSyncingStartupSelection] = useState(false);
  const [savingStartupSelection, setSavingStartupSelection] = useState(false);
  const [status, setStatus] = useState<McpStatusResponse | null>(null);
  const [detectedAgents, setDetectedAgents] = useState<McpAgentsResponse['detectedAgents']>([]);
  const [startupSelectedAgents, setStartupSelectedAgents] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [backendUrl, setBackendUrl] = useState(() => {
    const liveApiBase = String(getApiBaseUrl() || '').trim();
    return liveApiBase || 'http://127.0.0.1:3000/api';
  });
  const [config, setConfig] = useState<McpConfigResponse | null>(null);
  const [lastStartupSyncResult, setLastStartupSyncResult] = useState<McpSetupSyncResponse | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedAgentRef = useRef(selectedAgent);
  const configRequestIdRef = useRef(0);
  const backendUrlRef = useRef(backendUrl);

  const copyToClipboard = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error(`Failed to copy ${label.toLowerCase()}`);
    }
  }, []);

  useEffect(() => {
    backendUrlRef.current = backendUrl;
  }, [backendUrl]);

  useEffect(() => {
    selectedAgentRef.current = selectedAgent;
    if (!selectedAgent) {
      configRequestIdRef.current += 1;
      setLoadingConfig(false);
      setConfig(null);
    }
  }, [selectedAgent]);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const liveBackendUrl = String(getApiBaseUrl() || '').trim() || 'http://127.0.0.1:3000/api';
      backendUrlRef.current = liveBackendUrl;
      setBackendUrl(liveBackendUrl);

      const [statusResult, agentsResult, startupSelectionResult] = await Promise.allSettled([
        mcpApi.getStatus(liveBackendUrl),
        mcpApi.getAgents(liveBackendUrl),
        settingsApi.get(MCP_AUTO_SELECTED_AGENTS_KEY).catch(() => ({ exists: false, value: null })),
      ]);
      const statusResponse = statusResult.status === 'fulfilled' ? statusResult.value : null;
      const agentsResponse = agentsResult.status === 'fulfilled' ? agentsResult.value : null;
      const startupSelectionSetting = startupSelectionResult.status === 'fulfilled'
        ? startupSelectionResult.value
        : { exists: false, value: null };
      const nextDetectedAgents = agentsResponse?.detectedAgents || [];

      setStatus(statusResponse);
      setDetectedAgents(nextDetectedAgents);

      if (nextDetectedAgents.length === 0) {
        configRequestIdRef.current += 1;
        setLoadingConfig(false);
        setConfig(null);
      }

      setSelectedAgent((current) => {
        if (current && nextDetectedAgents.some((entry) => entry.id === current)) return current;
        const preferred = nextDetectedAgents.find((entry) => entry.isInstalled) || nextDetectedAgents[0];
        return preferred?.id || '';
      });

      const detectedAgentIdSet = new Set(nextDetectedAgents.map((entry) => entry.id));
      const savedSelection = parseMcpSelectedAgents(startupSelectionSetting?.value)
        .filter((id) => detectedAgentIdSet.has(id))
        .filter((id) => nextDetectedAgents.some((entry) => entry.id === id && entry.autoWriteSupported));
      const installedSelection = nextDetectedAgents
        .filter((entry) => entry.isInstalled && entry.autoWriteSupported)
        .map((entry) => entry.id);
      const defaultSelection = installedSelection.length > 0
        ? installedSelection
        : (nextDetectedAgents[0] ? [nextDetectedAgents[0].id] : []);
      setStartupSelectedAgents(startupSelectionSetting?.exists ? savedSelection : defaultSelection);

      if (statusResult.status === 'rejected' || agentsResult.status === 'rejected') {
        const loadMessage = statusResult.status === 'rejected'
          ? describeApiError(statusResult.reason, 'Failed to load MCP setup data')
          : describeApiError(
            agentsResult.status === 'rejected' ? agentsResult.reason : null,
            'Failed to load MCP setup data'
          );
        setError(loadMessage);
      }
    } catch (loadError: any) {
      setError(describeApiError(loadError, 'Failed to load MCP setup data'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConfig = useCallback(async (agentId: string, backendUrlOverride?: string) => {
    if (!agentId) return;
    const requestId = ++configRequestIdRef.current;
    setLoadingConfig(true);
    setError(null);
    try {
      const effectiveBackendUrl = String(backendUrlOverride ?? backendUrlRef.current).trim();
      const response = await mcpApi.getConfig(agentId, effectiveBackendUrl || undefined);
      if (requestId !== configRequestIdRef.current || selectedAgentRef.current !== agentId) return;
      setConfig(response);
    } catch (loadError: any) {
      if (requestId !== configRequestIdRef.current || selectedAgentRef.current !== agentId) return;
      setError(describeApiError(loadError, 'Failed to generate MCP config'));
      setConfig(null);
    } finally {
      if (requestId !== configRequestIdRef.current) return;
      setLoadingConfig(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!selectedAgent) return;
    void loadConfig(selectedAgent);
  }, [selectedAgent, loadConfig]);

  const persistStartupSelection = useCallback(async (nextSelection: string[]) => {
    setSavingStartupSelection(true);
    try {
      await settingsApi.set(MCP_AUTO_SELECTED_AGENTS_KEY, JSON.stringify(nextSelection));
      setStartupSelectedAgents(nextSelection);
    } catch (persistError: any) {
      const message = describeApiError(persistError, 'Failed to save MCP selection');
      setError(message);
      toast.error(message);
    } finally {
      setSavingStartupSelection(false);
    }
  }, []);

  const toggleStartupAgent = useCallback((agentId: string) => {
    const nextSelection = startupSelectedAgents.includes(agentId)
      ? startupSelectedAgents.filter((id) => id !== agentId)
      : [...startupSelectedAgents, agentId];
    void persistStartupSelection(nextSelection);
  }, [persistStartupSelection, startupSelectedAgents]);

  const syncStartupSelectionNow = useCallback(async () => {
    const effectiveBackendUrl = String(backendUrlRef.current || '').trim();
    setSyncingStartupSelection(true);
    setError(null);
    setLastStartupSyncResult(null);
    try {
      await settingsApi.set(MCP_AUTO_SELECTED_AGENTS_KEY, JSON.stringify(startupSelectedAgents));
      const response = await mcpApi.syncSetup({
        backendUrl: effectiveBackendUrl || undefined,
        selectedAgentIds: startupSelectedAgents,
        removeUnselected: startupSelectedAgents.length > 0,
        buildIfNeeded: true,
      });
      setLastStartupSyncResult(response);
      if (response.failures.length > 0) {
        toast.error(`MCP sync completed with ${response.failures.length} issue${response.failures.length === 1 ? '' : 's'}`);
      } else {
        toast.success('MCP sync completed');
      }
      await loadOverview();
      if (selectedAgent) {
        await loadConfig(selectedAgent, effectiveBackendUrl || undefined);
      }
    } catch (syncError: any) {
      const message = describeApiError(syncError, 'Failed to sync MCP selection');
      setError(message);
      toast.error(message);
    } finally {
      setSyncingStartupSelection(false);
    }
  }, [loadConfig, loadOverview, selectedAgent, startupSelectedAgents]);

  const selectedAgentDetails = detectedAgents.find((entry) => entry.id === selectedAgent) || null;
  const quickSetupCommand = status?.mcpServer?.recommendedCommands?.auto
    ? `cd mcp-review-server && npm run build && ${status.mcpServer.recommendedCommands.auto}`
    : `cd mcp-review-server && npm run build && node dist/bin/atlas-review-mcp.js setup --auto --backend-url ${JSON.stringify(backendUrl)}`;
  const selectedAgentCommand = selectedAgentDetails?.recommendedCommands?.preferred
    || config?.agent.recommendedCommands.preferred
    || (selectedAgent ? `node dist/bin/atlas-review-mcp.js setup --agent=${selectedAgent} --json` : '');
  const selectedSummary = startupSelectedAgents.length > 0
    ? startupSelectedAgents
      .map((agentId) => detectedAgents.find((entry) => entry.id === agentId)?.displayName || agentId)
      .join(', ')
    : 'None selected';
  const showManualFallback = !!error || !status?.mcpServer?.buildReady || !!lastStartupSyncResult?.failures?.length;

  if (loading) {
    return (
      <div style={cardStyle}>
        <div style={subsectionLabelStyle}>MCP Integrations</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          Loading MCP setup status...
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={cardStyle}>
        <div style={subsectionLabelStyle}>MCP Integrations In Terminal</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-3)', lineHeight: 1.6 }}>
          Select which tools Atlas should keep connected. Detected tools start enabled by default, and your selection auto-saves.
        </div>

        {detectedAgents.length > 0 ? (
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {detectedAgents.map((entry) => {
              const enabled = startupSelectedAgents.includes(entry.id);
              const isToggleDisabled = !entry.autoWriteSupported || savingStartupSelection || syncingStartupSelection;
              return (
                <div
                  key={entry.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-3)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-subtle)',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 500 }}>
                      {entry.displayName}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 4 }}>
                      MCP: {entry.mcpConnectionState.label}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 4 }}>
                      Workflow guidance: {entry.workflowGuidanceState.label}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleStartupAgent(entry.id)}
                    disabled={isToggleDisabled}
                    aria-pressed={enabled}
                    aria-label={`${enabled ? 'Disable' : 'Enable'} ${entry.displayName}`}
                    style={{
                      position: 'relative',
                      width: 36,
                      height: 20,
                      borderRadius: 10,
                      border: 'none',
                      background: enabled ? 'var(--accent-blue)' : 'var(--bg-hover)',
                      cursor: isToggleDisabled ? 'not-allowed' : 'pointer',
                      opacity: isToggleDisabled ? 0.5 : 1,
                      transition: 'background var(--transition-fast)',
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        top: 2,
                        left: enabled ? 18 : 2,
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        background: '#fff',
                        transition: 'left var(--transition-fast)',
                      }}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
            No supported tools were detected yet. You can still connect Atlas later from this screen once a supported client is installed.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
          <button
            type="button"
            style={btnPrimary}
            disabled={syncingStartupSelection || savingStartupSelection || detectedAgents.length === 0}
            onClick={() => void syncStartupSelectionNow()}
          >
            {syncingStartupSelection ? 'Syncing...' : 'Sync Selected Tools'}
          </button>
          <button
            type="button"
            style={btnSecondary}
            disabled={syncingStartupSelection || savingStartupSelection}
            onClick={() => void loadOverview()}
          >
            Refresh
          </button>
          <button
            type="button"
            style={btnSecondary}
            onClick={() => setShowAdvanced((current) => !current)}
          >
            {showAdvanced ? 'Hide Manual Setup' : 'Show Manual Setup'}
          </button>
          {savingStartupSelection && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              Saving selection...
            </span>
          )}
        </div>

        <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          Selected tools: {selectedSummary}
          <br />
          {status?.mcpServer?.buildReady ? 'MCP server build ready.' : status?.mcpServer?.remediation || 'MCP server build missing.'}
          {status?.mcpServer?.setupSeparationSummary && (
            <>
              <br />
              {status.mcpServer.setupSeparationSummary}
            </>
          )}
        </div>

        {lastStartupSyncResult && (
          <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
            Applied: {lastStartupSyncResult.appliedResults.map((entry) => entry.agentDisplayName).join(', ') || 'none'}
            <br />
            Removed: {lastStartupSyncResult.removedResults.filter((entry) => entry.changed).map((entry) => entry.agentDisplayName).join(', ') || 'none'}
          </div>
        )}

        {(showAdvanced || showManualFallback) && detectedAgents.length > 0 && (
          <details open={showAdvanced} style={{ marginTop: 'var(--space-3)' }}>
            <summary style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', cursor: 'pointer' }}>
              Manual setup
            </summary>
            <div style={{ marginTop: 'var(--space-3)', display: 'grid', gap: 'var(--space-3)' }}>
              <div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>Agent</div>
                <select
                  value={selectedAgent}
                  onChange={(event) => setSelectedAgent(event.target.value)}
                  style={selectStyle}
                  disabled={detectedAgents.length === 0}
                >
                  {detectedAgents.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.displayName} ({entry.isInstalled ? 'detected' : 'not detected'})
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  style={btnSecondary}
                  onClick={() => void copyToClipboard(selectedAgentCommand || quickSetupCommand, 'Command')}
                >
                  Copy Command
                </button>
                <button
                  type="button"
                  style={btnPrimary}
                  disabled={!config?.snippet || loadingConfig}
                  onClick={() => config?.snippet && void copyToClipboard(config.snippet, 'MCP config')}
                >
                  {loadingConfig ? 'Loading...' : 'Copy MCP Config'}
                </button>
                <button
                  type="button"
                  style={btnSecondary}
                  disabled={!selectedAgentDetails?.selectedConfigPath}
                  onClick={() => selectedAgentDetails?.selectedConfigPath && void copyToClipboard(selectedAgentDetails.selectedConfigPath, 'Path')}
                >
                  Copy Path
                </button>
              </div>

              {selectedAgentDetails && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                  Backend URL: <code style={{ fontFamily: 'var(--font-mono)' }}>{backendUrl}</code>
                  <br />
                  Target config: <code style={{ fontFamily: 'var(--font-mono)' }}>{selectedAgentDetails.selectedConfigPath || 'No verified path for this platform'}</code>
                  <br />
                  MCP status: {selectedAgentDetails.mcpConnectionState.label}
                  <br />
                  Workflow guidance: {selectedAgentDetails.workflowGuidanceState.label}
                  <br />
                  Restart: {selectedAgentDetails.restartHint || config?.agent.restartHint || 'Restart your agent client.'}
                </div>
              )}

              {config?.agent.workflowGuidance && (
                <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 500 }}>
                    {config.agent.workflowGuidance.title}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
                    {config.agent.workflowGuidance.defaultSummary}
                    <br />
                    {config.agent.workflowGuidance.installSummary}
                    <br />
                    {config.agent.workflowGuidanceState.summary}
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      style={btnSecondary}
                      onClick={() => void copyToClipboard(config.agent.workflowGuidance!.snippet, config.agent.workflowGuidance!.snippetLabel)}
                    >
                      Copy {config.agent.workflowGuidance.snippetLabel}
                    </button>
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
                    {config.agent.workflowGuidance.installSteps.map((step, index) => (
                      <div key={`${config.agent.id}-settings-workflow-step-${index}`}>{index + 1}. {step}</div>
                    ))}
                    <div style={{ marginTop: 6 }}>{config.agent.workflowGuidance.overrideSummary}</div>
                    <div>{config.agent.workflowGuidance.fallbackSummary}</div>
                  </div>
                  <pre style={{
                    margin: 0,
                    padding: 'var(--space-3)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-subtle)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--text-xs)',
                    overflowX: 'auto',
                    whiteSpace: 'pre-wrap',
                  }}
                  >
                    {config.agent.workflowGuidance.snippet}
                  </pre>
                </div>
              )}

              {config?.snippet && (
                <pre style={{
                  margin: 0,
                  padding: 'var(--space-3)',
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)',
                  fontSize: 'var(--text-xs)',
                  fontFamily: 'var(--font-mono)',
                  maxHeight: 260,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.4,
                }}>
                  {config.snippet}
                </pre>
              )}
            </div>
          </details>
        )}
      </div>

      {error && (
        <div style={{
          ...cardStyle,
          borderColor: 'var(--status-error, #ef4444)',
          color: 'var(--status-error, #ef4444)',
          fontSize: 'var(--text-sm)',
        }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cloud Section
// ---------------------------------------------------------------------------

function CloudSection() {
  const popup = usePopup();
  const [vercelToken, setVercelToken] = useState('');
  const [vercelTeamId, setVercelTeamId] = useState('');
  const [showVercelToken, setShowVercelToken] = useState(false);
  const [requireChecksDeploy, setRequireChecksDeploy] = useState(true);
  const [loadingDeploySettings, setLoadingDeploySettings] = useState(true);
  const [isSavingDeploySettings, setIsSavingDeploySettings] = useState(false);
  const [deployConfigured, setDeployConfigured] = useState(false);
  const [deployHasToken, setDeployHasToken] = useState(false);
  const [deployHasTeamId, setDeployHasTeamId] = useState(false);
  const [deployUsername, setDeployUsername] = useState<string | null>(null);
  const [savedTokenPreview, setSavedTokenPreview] = useState<string | null>(null);
  const [isEditingToken, setIsEditingToken] = useState(false);
  const [isResettingDeploySettings, setIsResettingDeploySettings] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadCloudSettings = async () => {
      try {
        const [deploymentRes, requireChecksRes] = await Promise.allSettled([
          atlasHostingApi.getDeploymentSettings(),
          settingsApi.get('require_checks_before_publish'),
        ]);

        if (!cancelled && deploymentRes.status === 'fulfilled') {
          setDeployConfigured(deploymentRes.value.configured);
          setDeployHasToken(deploymentRes.value.hasToken);
          setDeployHasTeamId(deploymentRes.value.hasTeamId);
          setVercelTeamId(deploymentRes.value.teamId || '');
          setSavedTokenPreview(deploymentRes.value.tokenPreview || null);
        }
        if (!cancelled && requireChecksRes.status === 'fulfilled' && requireChecksRes.value.exists && requireChecksRes.value.value != null) {
          setRequireChecksDeploy(requireChecksRes.value.value !== 'false');
        }
      } catch {
        // Use defaults
      } finally {
        if (!cancelled) {
          setLoadingDeploySettings(false);
        }
      }
    };

    void loadCloudSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  const openExternalLink = useCallback(async (url: string) => {
    if (isTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
        return;
      } catch {
        // Fall back to browser open below.
      }
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const handleSaveDeploySettings = useCallback(async () => {
    if (!vercelToken.trim()) {
      toast.error('Vercel token is required');
      return;
    }

    setIsSavingDeploySettings(true);
    setDeployUsername(null);
    try {
      const response = await atlasHostingApi.saveDeploymentSettings(
        vercelToken.trim(),
        vercelTeamId.trim() || undefined
      );
      setDeployConfigured(true);
      setDeployHasToken(true);
      setDeployHasTeamId(Boolean(response.teamId));
      setDeployUsername(response.username);
      setVercelTeamId(response.teamId || '');
      setSavedTokenPreview(response.tokenPreview || `${vercelToken.trim().slice(0, Math.min(10, vercelToken.trim().length))}...`);
      setVercelToken('');
      setIsEditingToken(false);
      setShowVercelToken(false);
      toast.success(response.message);
    } catch (error: any) {
      console.error('Failed to save deployment settings:', error);
      toast.error(error.response?.data?.error || 'Failed to save deployment settings');
    } finally {
      setIsSavingDeploySettings(false);
    }
  }, [vercelTeamId, vercelToken]);

  const handleRequireChecksDeployToggle = useCallback(async () => {
    const newVal = !requireChecksDeploy;
    setRequireChecksDeploy(newVal);
    try { await settingsApi.set('require_checks_before_publish', String(newVal)); }
    catch { setRequireChecksDeploy(!newVal); toast.error('Failed to save setting'); }
  }, [requireChecksDeploy]);

  const handleResetDeploySettings = useCallback(async () => {
    const confirmed = await popup.confirm({
      title: 'Reset Vercel Setup?',
      message: 'This will remove the saved Vercel token and team ID from this device.',
      confirmLabel: 'Reset',
      cancelLabel: 'Cancel',
      danger: true,
    });

    if (!confirmed) return;

    setIsResettingDeploySettings(true);
    try {
      const response = await atlasHostingApi.resetDeploymentSettings();
      setDeployConfigured(false);
      setDeployHasToken(false);
      setDeployHasTeamId(false);
      setDeployUsername(null);
      setSavedTokenPreview(null);
      setVercelToken('');
      setVercelTeamId('');
      setIsEditingToken(false);
      setShowVercelToken(false);
      toast.success(response.message);
    } catch (error: any) {
      console.error('Failed to reset deployment settings:', error);
      toast.error(error.response?.data?.error || 'Failed to reset Vercel setup');
    } finally {
      setIsResettingDeploySettings(false);
    }
  }, [popup]);

  const needsTokenInput = !deployHasToken && !deployConfigured && !vercelToken.trim();
  const isShowingSavedToken = deployHasToken && !isEditingToken && !vercelToken.trim();
  const hiddenSavedTokenValue = '••••••••••••••••';
  const tokenFieldValue = isShowingSavedToken
    ? (showVercelToken ? (savedTokenPreview || hiddenSavedTokenValue) : hiddenSavedTokenValue)
    : vercelToken;

  const handleTokenFieldFocus = useCallback(() => {
    if (!isShowingSavedToken) return;
    setIsEditingToken(true);
  }, [isShowingSavedToken]);

  return (
    <div>
      <div style={cardStyle}>
        <div style={subsectionLabelStyle}>Deployment</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-4)', lineHeight: 1.6 }}>
          Connect Vercel once to enable one-click publish from Atlas.
        </div>

        <div style={{ marginBottom: 'var(--space-3)' }}>
          <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: needsTokenInput ? '#fca5a5' : 'var(--text-tertiary)', marginBottom: 4 }}>
            Personal Access Token
          </label>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <input
              type={showVercelToken ? 'text' : 'password'}
              value={tokenFieldValue}
              onChange={(e) => {
                setIsEditingToken(true);
                setVercelToken(e.target.value);
              }}
              onFocus={handleTokenFieldFocus}
              onBlur={() => {
                if (!vercelToken.trim()) {
                  setIsEditingToken(false);
                }
              }}
              placeholder={deployHasToken ? 'Enter a new token to replace the saved one' : 'vercel_...'}
              disabled={loadingDeploySettings || isSavingDeploySettings}
              readOnly={isShowingSavedToken}
              style={{
                ...inputStyle,
                opacity: loadingDeploySettings ? 0.5 : 1,
                border: needsTokenInput ? '1px solid rgba(239, 68, 68, 0.55)' : inputStyle.border,
                background: needsTokenInput ? 'rgba(127, 29, 29, 0.18)' : inputStyle.background,
              }}
            />
            <button
              type="button"
              onClick={() => setShowVercelToken(!showVercelToken)}
              style={{ ...btnBase, background: 'transparent', color: 'var(--text-tertiary)', padding: 'var(--space-1)', flexShrink: 0 }}
              title={showVercelToken ? 'Hide token' : 'Show token'}
            >
              {showVercelToken ? (
                <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: needsTokenInput ? '#fca5a5' : 'var(--text-tertiary)', marginTop: 6 }}>
            {deployConfigured
              ? `${deployUsername ? `Connected as ${deployUsername}. ` : ''}${savedTokenPreview ? `Saved token: ${savedTokenPreview}. ` : ''}Enter a new token only if you want to replace the saved one.`
              : 'Required. Add your Vercel personal access token to enable publish.'}
          </div>
        </div>

        <div style={{ marginBottom: 'var(--space-3)' }}>
          <label style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 4 }}>
            Team ID <span style={{ color: 'var(--text-quaternary)' }}>(optional)</span>
          </label>
          <input
            type="text"
            value={vercelTeamId}
            onChange={(e) => setVercelTeamId(e.target.value)}
            placeholder={deployHasTeamId ? '(team ID saved — enter a new one to replace it)' : 'team_xxx (leave empty for personal account)'}
            disabled={loadingDeploySettings || isSavingDeploySettings}
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)', opacity: loadingDeploySettings ? 0.5 : 1 }}
          />
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 6 }}>
            Leave empty for personal accounts.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => { void openExternalLink('https://vercel.com/account/tokens'); }}
            style={{ ...(needsTokenInput ? btnPrimary : btnSecondary), fontSize: 'var(--text-sm)' }}
          >
            Open Token Page
          </button>
          <button
            type="button"
            onClick={() => { void handleSaveDeploySettings(); }}
            disabled={loadingDeploySettings || isSavingDeploySettings || isResettingDeploySettings || !vercelToken.trim()}
            style={{
              ...btnPrimary,
              fontSize: 'var(--text-sm)',
              opacity: (loadingDeploySettings || isSavingDeploySettings || isResettingDeploySettings || !vercelToken.trim()) ? 0.6 : 1,
              cursor: (loadingDeploySettings || isSavingDeploySettings || isResettingDeploySettings || !vercelToken.trim()) ? 'not-allowed' : 'pointer',
            }}
          >
            {isSavingDeploySettings ? 'Validating...' : 'Test & Save'}
          </button>
          {(deployHasToken || deployHasTeamId) && (
            <button
              type="button"
              onClick={() => { void handleResetDeploySettings(); }}
              disabled={isSavingDeploySettings || isResettingDeploySettings}
              style={{
                ...btnSecondary,
                fontSize: 'var(--text-sm)',
                color: 'var(--status-error, #fca5a5)',
                opacity: (isSavingDeploySettings || isResettingDeploySettings) ? 0.6 : 1,
                cursor: (isSavingDeploySettings || isResettingDeploySettings) ? 'not-allowed' : 'pointer',
              }}
            >
              {isResettingDeploySettings ? 'Resetting...' : 'Reset'}
            </button>
          )}
          {deployHasToken && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>Token saved on this device</span>}
        </div>
      </div>

      <div style={cardStyle}>
        <div style={subsectionLabelStyle}>Publish Guardrails</div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            cursor: loadingDeploySettings ? 'not-allowed' : 'pointer',
            opacity: loadingDeploySettings ? 0.5 : 1,
          }}
        >
          <input
            type="checkbox"
            checked={requireChecksDeploy}
            onChange={handleRequireChecksDeployToggle}
            disabled={loadingDeploySettings}
            style={{ accentColor: 'var(--accent-blue)', width: 14, height: 14 }}
          />
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
            Require checks to pass before publish
          </span>
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// About Section
// ---------------------------------------------------------------------------

const SUPPORT_URL = 'mailto:support@atlasengine.dev';
const LICENSE_PATH = 'https://atlasengine.dev/LICENSE.txt';
const DISCORD_INVITE_URL = 'https://discord.gg/tyMsmCnf';

function AboutSection() {
  const [appVersion, setAppVersion] = useState<string>(isTauri ? 'Loading...' : 'Web preview');
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!isTauri) {
      setAppVersion('Web preview');
      return () => {
        cancelled = true;
      };
    }

    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppVersion('Unavailable');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCheckUpdates = useCallback(async () => {
    setIsChecking(true);
    setUpdateStatus(null);

    // NOTE: When @tauri-apps/plugin-updater is added as a dependency,
    // this can be replaced with: const { check } = await import('@tauri-apps/plugin-updater');
    // For now, show a generic message in both web and Tauri modes.
    await new Promise(resolve => setTimeout(resolve, 500)); // Brief pause for UX
    setUpdateStatus('You are on the latest version.');

    setIsChecking(false);
  }, []);

  const openLink = useCallback((url: string) => {
    const resolvedUrl = /^(https?:|mailto:)/i.test(url)
      ? url
      : new URL(url, window.location.origin).toString();

    if (isTauri) {
      import('@tauri-apps/plugin-shell').then(({ open }) => open(resolvedUrl)).catch(() => {
        window.open(resolvedUrl, '_blank', 'noopener,noreferrer');
      });
    } else {
      window.open(resolvedUrl, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const linkStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm)',
    color: 'var(--accent-blue)',
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
    textDecoration: 'none',
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: 'var(--space-6)',
      gap: 'var(--space-4)',
    }}>
      {/* App branding */}
      <div style={{ textAlign: 'center' }}>
        <div style={{
          fontSize: 'var(--text-xl, 1.25rem)',
          fontWeight: 700,
          color: 'var(--text-primary)',
        }}>
          AtlasEngine
        </div>
        <div style={{
          fontSize: 'var(--text-sm)',
          color: 'var(--text-tertiary)',
          marginTop: 4,
        }}>
          AI code review with Builder verification and publish
        </div>
        <div style={{
          fontSize: 'var(--text-sm)',
          fontWeight: 600,
          color: 'var(--text-secondary)',
          marginTop: 'var(--space-2)',
          fontFamily: 'var(--font-mono)',
        }}>
          v{appVersion}
        </div>
      </div>

      {/* Check for Updates */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)' }}>
        <button
          type="button"
          onClick={handleCheckUpdates}
          disabled={isChecking}
          style={{ ...btnSecondary, opacity: isChecking ? 0.6 : 1 }}
        >
          {isChecking ? 'Checking...' : 'Check for Updates'}
        </button>
        {updateStatus && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            {updateStatus}
          </div>
        )}
      </div>

      {/* Links */}
      <div style={{
        ...cardStyle,
        width: '100%',
        maxWidth: 400,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Website</span>
          <button type="button" onClick={() => openLink('https://atlasengine.dev')} style={linkStyle}>
            atlasengine.dev
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Documentation</span>
          <button type="button" onClick={() => openLink('https://docs.atlasengine.dev')} style={linkStyle}>
            docs.atlasengine.dev
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Discord</span>
          <button type="button" onClick={() => openLink(DISCORD_INVITE_URL)} style={linkStyle}>
            Join Discord
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>Support</span>
          <button type="button" onClick={() => openLink(SUPPORT_URL)} style={linkStyle}>
            support@atlasengine.dev
          </button>
        </div>
      </div>

      {/* License & Credits */}
      <div style={{ display: 'flex', gap: 'var(--space-4)' }}>
        <button
          type="button"
          onClick={() => openLink(LICENSE_PATH)}
          style={linkStyle}
        >
          View License
        </button>
        <button
          type="button"
          onClick={() => toast('Credits page coming soon', { icon: 'i' })}
          style={{ ...linkStyle, color: 'var(--text-tertiary)' }}
        >
          View Credits
        </button>
      </div>
    </div>
  );
}

export default GlobalSettingsModal;
