/**
 * Settings Panel Component
 * Project settings with sidebar navigation for General and Secrets sections
 */

import { useState, useEffect } from 'react';
import toast from '@/lib/toast';
import { projectApi, hostingApi, secretsApi, atlasHostingApi, providerApi, settingsApi, usageApi, HostingInfo } from '@/services/api';
import { supabaseApi } from '@/services/supabaseApi';
import type { SupabaseStatus, SupabaseOrganization, SupabaseProject, SupabaseLinkedProject } from '@/services/supabaseApi';
import type { UsageSummary, UsageRecord, ProviderBreakdown } from '@/services/api';
import type { ProjectSecret, IntegrationCheck, MissingVar, AIProvider } from '@/types';
import { isTauriEnvironment } from '@/utils/tauri';
import { isProviderUsable } from '@/utils/providerStatus';
import { emitAutoReviewSettingChanged } from '@/constants/autoReviewEvents';

interface SettingsPanelProps {
  projectId: string;
  projectName: string;
  onProjectRenamed?: (projectId: string, name: string) => void;
  onProjectDeleted?: () => void;
}

const isTauri = isTauriEnvironment();

type SettingsTab = 'general' | 'secrets' | 'supabase' | 'deployment' | 'ai_provider' | 'usage';

function SettingsPanel({ projectId, projectName, onProjectRenamed, onProjectDeleted }: SettingsPanelProps) {
  // Navigation state
  const [activeTab, setActiveTab] = useState<SettingsTab>('secrets');

  // Project rename state
  const [editName, setEditName] = useState(projectName);
  const [isSavingName, setIsSavingName] = useState(false);
  useEffect(() => { setEditName(projectName); }, [projectName]);

  // Project deletion state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // Hosting state
  const [hosting, setHosting] = useState<HostingInfo | null>(null);
  const [loadingHosting, setLoadingHosting] = useState(true);
  const [showDisableDomainDialog, setShowDisableDomainDialog] = useState(false);
  const [showDeleteHostingDialog, setShowDeleteHostingDialog] = useState(false);
  const [hostingConfirmSlug, setHostingConfirmSlug] = useState('');
  const [isDisablingDomain, setIsDisablingDomain] = useState(false);
  const [isDeletingHosting, setIsDeletingHosting] = useState(false);

  // Secrets state
  const [secrets, setSecrets] = useState<ProjectSecret[]>([]);
  const [loadingSecrets, setLoadingSecrets] = useState(true);
  const [showAddSecretForm, setShowAddSecretForm] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingSecretId, setEditingSecretId] = useState<string | null>(null);
  const [deleteSecretId, setDeleteSecretId] = useState<string | null>(null);

  // Add/Edit form state
  const [secretKey, setSecretKey] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [isSecretFlag, setIsSecretFlag] = useState(true);
  const [isSavingSecret, setIsSavingSecret] = useState(false);

  // Import modal state
  const [importContent, setImportContent] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  // Reveal/copy state
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, string>>({});
  const [revealingSecrets, setRevealingSecrets] = useState<Record<string, boolean>>({});
  const [copyingSecrets, setCopyingSecrets] = useState<Record<string, boolean>>({});

  // Integrations state
  const [integrations, setIntegrations] = useState<IntegrationCheck[]>([]);
  const [missingVars, setMissingVars] = useState<MissingVar[]>([]);
  const [loadingIntegrations, setLoadingIntegrations] = useState(true);

  // AI Provider state
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [activeProvider, setActiveProvider] = useState<AIProvider | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [providerConfigs, setProviderConfigs] = useState<Array<{
    type: string;
    label: string;
    models: Array<{ id: string; label: string }>;
    defaultModel: string;
    byokEligible?: boolean;
  }>>([]);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [byokType, setByokType] = useState('anthropic');
  const [byokApiKey, setByokApiKey] = useState('');
  const [byokModel, setByokModel] = useState('');
  const [isSavingProvider, setIsSavingProvider] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; latencyMs: number; error?: string } | null>(null);

  // Branch auto-review state
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(false);
  const [loadingAutoReview, setLoadingAutoReview] = useState(true);

  // Require checks before publish state
  const [requireChecksBeforePublish, setRequireChecksBeforePublish] = useState(true);
  const [loadingRequireChecks, setLoadingRequireChecks] = useState(true);

  // Usage tracking state
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [usageBreakdown, setUsageBreakdown] = useState<ProviderBreakdown[]>([]);
  const [loadingUsage, setLoadingUsage] = useState(true);

  // Deployment settings state (desktop-only)
  const [deployToken, setDeployToken] = useState('');
  const [deployTeamId, setDeployTeamId] = useState('');
  const [deployConfigured, setDeployConfigured] = useState(false);
  const [deployHasTeamId, setDeployHasTeamId] = useState(false);
  const [isSavingDeploy, setIsSavingDeploy] = useState(false);
  const [deployUsername, setDeployUsername] = useState<string | null>(null);
  const [showDeployToken, setShowDeployToken] = useState(false);

  // Supabase state
  const [supabaseStatus, setSupabaseStatus] = useState<SupabaseStatus | null>(null);
  const [_supabaseOrgs, setSupabaseOrgs] = useState<SupabaseOrganization[]>([]);
  const [supabaseProjects, setSupabaseProjects] = useState<SupabaseProject[]>([]);
  const [supabaseLinked, setSupabaseLinked] = useState<SupabaseLinkedProject | null>(null);
  const [loadingSupabase, setLoadingSupabase] = useState(true);
  const [connectingSupabase, setConnectingSupabase] = useState(false);
  const [linkingSupabase, setLinkingSupabase] = useState(false);
  const [selectedSupabaseProject, setSelectedSupabaseProject] = useState('');
  const [supabaseToken, setSupabaseToken] = useState('');
  const [showDeleteDbDialog, setShowDeleteDbDialog] = useState(false);
  const [dbConfirmName, setDbConfirmName] = useState('');
  const [isDeletingDb, setIsDeletingDb] = useState(false);

  // Load hosting status and secrets on mount
  useEffect(() => {
    const loadHostingStatus = async () => {
      try {
        const response = await hostingApi.getStatus(projectId);
        setHosting(response.hosting);
      } catch (error) {
        console.error('Failed to load hosting status:', error);
      } finally {
        setLoadingHosting(false);
      }
    };

    const loadSecrets = async () => {
      try {
        const response = await secretsApi.list(projectId);
        setSecrets(response.secrets);
      } catch (error) {
        console.error('Failed to load secrets:', error);
      } finally {
        setLoadingSecrets(false);
      }
    };

    const loadIntegrations = async () => {
      try {
        const response = await secretsApi.getIntegrations(projectId);
        setIntegrations(response.integrations);
        setMissingVars(response.missingVars);
      } catch (error) {
        console.error('Failed to load integrations:', error);
      } finally {
        setLoadingIntegrations(false);
      }
    };

    loadHostingStatus();
    loadSecrets();
    loadIntegrations();

    // Load AI providers. The backend may serve cached data and refresh in
    // the background (`scanInFlight: true`); in that case re-fetch once
    // after a short delay so the user sees the freshly-detected state
    // without a manual click.
    let providerRefetchTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const refetchProviderList = async () => {
      try {
        const result = await providerApi.list();
        if (cancelled) return;
        setProviders(result.providers);
        setActiveProvider(result.activeProvider);
      } catch (error) {
        console.error('Failed to refresh providers:', error);
      }
    };

    const loadProviders = async () => {
      try {
        const [providersResult, configsResult] = await Promise.all([
          providerApi.list(),
          providerApi.getConfigs(),
        ]);
        if (cancelled) return;
        setProviders(providersResult.providers);
        setActiveProvider(providersResult.activeProvider);
        setProviderConfigs(configsResult.configs);
        if (providersResult.scanInFlight) {
          providerRefetchTimer = setTimeout(refetchProviderList, 2500);
        }
      } catch (error) {
        console.error('Failed to load providers:', error);
      } finally {
        if (!cancelled) setLoadingProviders(false);
      }
    };
    loadProviders();

    // Load deployment settings (desktop-only)
    if (isTauri) {
      const loadDeploySettings = async () => {
        try {
          const response = await atlasHostingApi.getDeploymentSettings();
          setDeployConfigured(response.configured);
          setDeployHasTeamId(response.hasTeamId);
          setDeployTeamId(response.teamId || '');
        } catch (error) {
          console.error('Failed to load deployment settings:', error);
        }
      };
      loadDeploySettings();
    }

    // Load branch auto-review setting
    const loadAutoReview = async () => {
      try {
        const result = await settingsApi.get('auto_review_enabled');
        setAutoReviewEnabled(result.value !== 'false');
      } catch {
        setAutoReviewEnabled(true);
      } finally {
        setLoadingAutoReview(false);
      }
    };
    loadAutoReview();

    // Load require-checks-before-publish setting
    const loadRequireChecks = async () => {
      try {
        const result = await settingsApi.get('require_checks_before_publish');
        setRequireChecksBeforePublish(result.value !== 'false');
      } catch {
        // Not found — default true
      } finally {
        setLoadingRequireChecks(false);
      }
    };
    loadRequireChecks();

    // Load usage data
    const loadUsage = async () => {
      try {
        const [summary, records, breakdown] = await Promise.all([
          usageApi.getSummary(),
          usageApi.getRecent(10),
          usageApi.getBreakdown(),
        ]);
        setUsageSummary(summary);
        setUsageRecords(records);
        setUsageBreakdown(breakdown);
      } catch (error) {
        console.error('Failed to load usage data:', error);
      } finally {
        setLoadingUsage(false);
      }
    };
    loadUsage();

    // Load Supabase status
    const loadSupabase = async () => {
      try {
        const [status, linked] = await Promise.all([
          supabaseApi.getStatus(),
          supabaseApi.getLinkedProject(projectId),
        ]);
        setSupabaseStatus(status);
        setSupabaseLinked(linked);

        if (status.connected) {
          const [orgs, projects] = await Promise.all([
            supabaseApi.getOrganizations(),
            supabaseApi.getProjects(),
          ]);
          setSupabaseOrgs(orgs);
          setSupabaseProjects(projects);
        }
      } catch (error) {
        console.error('Failed to load Supabase status:', error);
      } finally {
        setLoadingSupabase(false);
      }
    };
    loadSupabase();

    return () => {
      cancelled = true;
      if (providerRefetchTimer) clearTimeout(providerRefetchTimer);
    };
  }, [projectId]);

  // Project deletion handlers
  const handleDeleteClick = () => {
    setShowDeleteDialog(true);
    setConfirmText('');
  };

  const handleCancelDelete = () => {
    setShowDeleteDialog(false);
    setConfirmText('');
  };

  const handleConfirmDelete = async () => {
    if (confirmText !== projectName) {
      toast.error('Project name does not match');
      return;
    }

    console.log(`[SettingsPanel] Starting deletion for project: ${projectId} (${projectName})`);
    setIsDeleting(true);

    try {
      console.log(`[SettingsPanel] Calling projectApi.delete for project: ${projectId}`);
      const response = await projectApi.delete(projectId);

      console.log(`[SettingsPanel] Delete response:`, response);

      if (response.success) {
        toast.success('Project deleted successfully');
        setShowDeleteDialog(false);

        console.log(`[SettingsPanel] Calling onProjectDeleted callback`);
        if (onProjectDeleted) {
          onProjectDeleted();
        }
      } else {
        const errorMsg = (response as any).error || 'Failed to delete project';
        console.error(`[SettingsPanel] Delete failed:`, errorMsg);
        toast.error(errorMsg);
      }
    } catch (error: any) {
      console.error('[SettingsPanel] Error deleting project:', error);
      console.error('[SettingsPanel] Error response:', error.response);
      toast.error(error.response?.data?.error || 'Failed to delete project');
    } finally {
      setIsDeleting(false);
    }
  };

  // Hosting management handlers
  const handleDisableDomain = async () => {
    setIsDisablingDomain(true);
    try {
      const response = await hostingApi.disableDomain(projectId);
      if (response.success) {
        toast.success('Production URL disabled');
        setShowDisableDomainDialog(false);
        // Reload hosting status
        const statusResponse = await hostingApi.getStatus(projectId);
        setHosting(statusResponse.hosting);
      }
    } catch (error: any) {
      console.error('Failed to disable domain:', error);
      toast.error(error.response?.data?.error || 'Failed to disable production URL');
    } finally {
      setIsDisablingDomain(false);
    }
  };

  const handleDeleteHosting = async () => {
    if (!hosting || hostingConfirmSlug !== hosting.customDomain.split('.')[0]) {
      toast.error('Project slug does not match');
      return;
    }

    setIsDeletingHosting(true);
    try {
      const response = await hostingApi.deleteHosting(projectId, hostingConfirmSlug);
      if (response.success) {
        toast.success('Hosting resources deleted');
        setShowDeleteHostingDialog(false);
        setHostingConfirmSlug('');
        setHosting(null);
      }
    } catch (error: any) {
      console.error('Failed to delete hosting:', error);
      toast.error(error.response?.data?.error || 'Failed to delete hosting resources');
    } finally {
      setIsDeletingHosting(false);
    }
  };

  const expectedSlug = hosting?.customDomain.split('.')[0] || '';

  // Secrets handlers
  const resetSecretForm = () => {
    setSecretKey('');
    setSecretValue('');
    setIsSecretFlag(true);
    setShowAddSecretForm(false);
    setEditingSecretId(null);
  };

  const handleAddSecret = async () => {
    if (!secretKey.trim()) {
      toast.error('Key is required');
      return;
    }

    setIsSavingSecret(true);
    try {
      const response = await secretsApi.create(projectId, {
        key: secretKey.trim(),
        value: secretValue,
        isSecret: isSecretFlag,
      });

      if (response.success) {
        setSecrets([...secrets, response.secret]);
        toast.success('Variable added');
        resetSecretForm();
        // Reload integrations to update missing vars
        reloadIntegrations();
      }
    } catch (error: any) {
      console.error('Failed to add secret:', error);
      toast.error(error.response?.data?.error || 'Failed to add variable');
    } finally {
      setIsSavingSecret(false);
    }
  };

  const handleEditSecret = (secret: ProjectSecret) => {
    setEditingSecretId(secret.id);
    setSecretKey(secret.key);
    setSecretValue(''); // Don't prefill masked values
    setIsSecretFlag(secret.isSecret);
    setShowAddSecretForm(false);
  };

  const handleUpdateSecret = async () => {
    if (!editingSecretId || !secretKey.trim()) {
      toast.error('Key is required');
      return;
    }

    setIsSavingSecret(true);
    try {
      const updates: { key?: string; value?: string; isSecret?: boolean } = {
        key: secretKey.trim(),
        isSecret: isSecretFlag,
      };

      // Only include value if it was changed (not empty)
      if (secretValue) {
        updates.value = secretValue;
      }

      const response = await secretsApi.update(projectId, editingSecretId, updates);

      if (response.success) {
        setSecrets(secrets.map(s => s.id === editingSecretId ? response.secret : s));
        toast.success('Variable updated');
        resetSecretForm();
      }
    } catch (error: any) {
      console.error('Failed to update secret:', error);
      toast.error(error.response?.data?.error || 'Failed to update variable');
    } finally {
      setIsSavingSecret(false);
    }
  };

  const handleDeleteSecret = async () => {
    if (!deleteSecretId) return;

    try {
      const response = await secretsApi.delete(projectId, deleteSecretId);

      if (response.success) {
        setSecrets(secrets.filter(s => s.id !== deleteSecretId));
        toast.success('Variable deleted');
        setDeleteSecretId(null);
        // Reload integrations to update missing vars
        reloadIntegrations();
      }
    } catch (error: any) {
      console.error('Failed to delete secret:', error);
      toast.error(error.response?.data?.error || 'Failed to delete variable');
    }
  };

  const handleImportEnv = async () => {
    if (!importContent.trim()) {
      toast.error('Content is required');
      return;
    }

    setIsImporting(true);
    try {
      const response = await secretsApi.importEnv(projectId, importContent);

      if (response.success) {
        toast.success(response.message);
        setShowImportModal(false);
        setImportContent('');

        // Reload secrets and integrations
        const listResponse = await secretsApi.list(projectId);
        setSecrets(listResponse.secrets);
        reloadIntegrations();
      }
    } catch (error: any) {
      console.error('Failed to import secrets:', error);
      toast.error(error.response?.data?.error || 'Failed to import variables');
    } finally {
      setIsImporting(false);
    }
  };

  // Reveal/copy handlers
  const handleRevealToggle = async (secret: ProjectSecret) => {
    const secretId = secret.id;

    // If already revealed, hide it
    if (revealedSecrets[secretId]) {
      setRevealedSecrets((prev) => {
        const next = { ...prev };
        delete next[secretId];
        return next;
      });
      return;
    }

    // Fetch the value
    setRevealingSecrets((prev) => ({ ...prev, [secretId]: true }));
    try {
      const response = await secretsApi.getValue(projectId, secretId);
      if (response.success) {
        setRevealedSecrets((prev) => ({ ...prev, [secretId]: response.value }));

        // Auto-hide after 30 seconds for security
        setTimeout(() => {
          setRevealedSecrets((prev) => {
            const next = { ...prev };
            delete next[secretId];
            return next;
          });
        }, 30000);
      }
    } catch (error: any) {
      console.error('Failed to reveal secret:', error);
      toast.error(error.response?.data?.error || 'Failed to reveal value');
    } finally {
      setRevealingSecrets((prev) => ({ ...prev, [secretId]: false }));
    }
  };

  const handleCopySecret = async (secret: ProjectSecret) => {
    const secretId = secret.id;

    setCopyingSecrets((prev) => ({ ...prev, [secretId]: true }));
    try {
      let valueToCopy: string;

      // If already revealed, use cached value
      if (revealedSecrets[secretId]) {
        valueToCopy = revealedSecrets[secretId];
      } else {
        // Fetch the value without revealing
        const response = await secretsApi.getValue(projectId, secretId);
        if (!response.success) {
          throw new Error('Failed to get value');
        }
        valueToCopy = response.value;
      }

      await navigator.clipboard.writeText(valueToCopy);
      toast.success('Copied to clipboard');
    } catch (error: any) {
      console.error('Failed to copy secret:', error);
      toast.error(error.response?.data?.error || 'Failed to copy value');
    } finally {
      setCopyingSecrets((prev) => ({ ...prev, [secretId]: false }));
    }
  };

  // Quick-add handler for missing integration vars
  const handleQuickAddVar = (varKey: string) => {
    resetSecretForm();
    setSecretKey(varKey);
    setShowAddSecretForm(true);
  };

  // Reload integrations after secrets change
  const reloadIntegrations = async () => {
    try {
      const response = await secretsApi.getIntegrations(projectId);
      setIntegrations(response.integrations);
      setMissingVars(response.missingVars);
    } catch (error) {
      console.error('Failed to reload integrations:', error);
    }
  };

  // AI Provider handlers
  const handleScanProviders = async () => {
    setIsScanning(true);
    try {
      const result = await providerApi.scan();
      setProviders(result.providers);
      setActiveProvider(result.activeProvider);
      window.dispatchEvent(new Event('provider-changed'));
      if (result.activeProvider) {
        toast.success(`Connected: ${result.activeProvider.label}`);
      } else if (result.providers.length > 0) {
        toast.success(`Found ${result.providers.length} provider(s)`);
      } else {
        toast('No AI tools detected. Add an API key manually.', { icon: 'i' });
      }
    } catch (error: unknown) {
      toast.error('Scan failed');
    } finally {
      setIsScanning(false);
    }
  };

  const handleTestConnection = async () => {
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
  };

  const handleAddProvider = async () => {
    if (!byokApiKey.trim()) {
      toast.error('API key is required');
      return;
    }
    setIsSavingProvider(true);
    try {
      const result = await providerApi.addBYOK(byokType, byokApiKey.trim(), byokModel || undefined);
      if (result.provider.status === 'connected') {
        toast.success(`${result.provider.label} connected`);
      } else {
        toast.error(result.provider.error || 'Connection failed');
      }
      // Refresh providers list
      const updated = await providerApi.list();
      setProviders(updated.providers);
      setActiveProvider(updated.activeProvider);
      setShowAddProvider(false);
      setByokApiKey('');
      setByokModel('');
      setTestResult(null);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Failed to add provider';
      toast.error(msg);
    } finally {
      setIsSavingProvider(false);
    }
  };

  const handleSetActiveProvider = async (providerId: string) => {
    try {
      const result = await providerApi.setActive(providerId);
      const selectedProvider = providers.find((provider) => provider.id === providerId) || result.provider;
      setProviders(prev => prev.map(p => ({ ...p, isActive: p.id === providerId })));
      setActiveProvider(result.provider);
      window.dispatchEvent(new Event('provider-changed'));

      try {
        await Promise.all([
          providerApi.setContextActive('review', providerId, selectedProvider?.model),
          providerApi.setContextActive('build', providerId, selectedProvider?.model),
        ]);
        toast.success(`Active: ${result.provider.label}`);
      } catch (contextError) {
        console.warn('Failed to sync provider contexts after setting active provider', contextError);
        toast.error('Active provider set, but review/build sync failed. Try reselecting.');
      }
    } catch {
      toast.error('Failed to set active provider');
    }
  };

  const handleRemoveProvider = async (providerId: string) => {
    try {
      await providerApi.remove(providerId);
      const updated = await providerApi.list();
      setProviders(updated.providers);
      setActiveProvider(updated.activeProvider);
      toast.success('Provider removed');
    } catch {
      toast.error('Failed to remove provider');
    }
  };

  // Branch auto-review toggle handler
  const handleAutoReviewToggle = async () => {
    const newValue = !autoReviewEnabled;
    setAutoReviewEnabled(newValue);
    try {
      await settingsApi.set('auto_review_enabled', String(newValue));
      emitAutoReviewSettingChanged(newValue);
      toast.success(newValue ? 'Auto-review enabled' : 'Auto-review disabled');
    } catch {
      setAutoReviewEnabled(!newValue); // Revert on error
      toast.error('Failed to update setting');
    }
  };

  // Require checks before publish toggle handler
  const handleRequireChecksToggle = async () => {
    const newValue = !requireChecksBeforePublish;
    setRequireChecksBeforePublish(newValue);
    try {
      await settingsApi.set('require_checks_before_publish', String(newValue));
      toast.success(newValue ? 'Checks required before publish' : 'Publish without checks allowed');
    } catch {
      setRequireChecksBeforePublish(!newValue); // Revert on error
      toast.error('Failed to update setting');
    }
  };

  // Deployment settings handler (desktop-only)
  const handleSaveDeploySettings = async () => {
    if (!deployToken.trim()) {
      toast.error('Vercel token is required');
      return;
    }

    setIsSavingDeploy(true);
    setDeployUsername(null);
    try {
      const response = await atlasHostingApi.saveDeploymentSettings(
        deployToken.trim(),
        deployTeamId.trim() || undefined
      );
      if (response.success) {
        toast.success(response.message);
        setDeployConfigured(true);
        setDeployUsername(response.username);
        setDeployHasTeamId(Boolean(response.teamId));
        setDeployTeamId(response.teamId || '');
        setDeployToken(''); // Clear sensitive field
      }
    } catch (error: any) {
      console.error('Failed to save deployment settings:', error);
      toast.error(error.response?.data?.error || 'Failed to save deployment settings');
    } finally {
      setIsSavingDeploy(false);
    }
  };

  // Supabase handlers
  const handleConnectSupabase = async () => {
    if (!supabaseToken.trim()) {
      toast.error('Please enter your Supabase access token');
      return;
    }
    setConnectingSupabase(true);
    try {
      await supabaseApi.connect(supabaseToken.trim());
      setSupabaseToken('');
      // Reload status + projects
      const status = await supabaseApi.getStatus();
      setSupabaseStatus(status);
      if (status.connected) {
        const [orgs, projects] = await Promise.all([
          supabaseApi.getOrganizations(),
          supabaseApi.getProjects(),
        ]);
        setSupabaseOrgs(orgs);
        setSupabaseProjects(projects);
      }
      toast.success('Supabase connected');
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to connect Supabase');
    } finally {
      setConnectingSupabase(false);
    }
  };

  const handleDisconnectSupabase = async () => {
    try {
      await supabaseApi.disconnect();
      setSupabaseStatus({ connected: false });
      setSupabaseOrgs([]);
      setSupabaseProjects([]);
      toast.success('Supabase disconnected');
    } catch {
      toast.error('Failed to disconnect Supabase');
    }
  };

  const handleLinkSupabase = async () => {
    if (!selectedSupabaseProject) {
      toast.error('Select a Supabase project first');
      return;
    }
    setLinkingSupabase(true);
    try {
      const result = await supabaseApi.linkProject(projectId, { supabaseProjectRef: selectedSupabaseProject });
      setSupabaseLinked(result.linked);
      toast.success('Supabase project linked');
    } catch (error: any) {
      toast.error(error.response?.data?.error || 'Failed to link project');
    } finally {
      setLinkingSupabase(false);
    }
  };

  const handleUnlinkSupabase = async () => {
    try {
      await supabaseApi.unlinkProject(projectId, true);
      setSupabaseLinked(null);
      setSelectedSupabaseProject('');
      toast.success('Supabase project unlinked');
    } catch {
      toast.error('Failed to unlink project');
    }
  };

  const handleDeleteDatabase = async () => {
    if (!supabaseLinked || dbConfirmName !== supabaseLinked.supabase_project_name) {
      toast.error('Project name does not match');
      return;
    }

    setIsDeletingDb(true);
    try {
      await supabaseApi.deleteDatabase(projectId, dbConfirmName);
      setSupabaseLinked(null);
      setSelectedSupabaseProject('');
      setShowDeleteDbDialog(false);
      setDbConfirmName('');
      toast.success('Supabase database deleted');
    } catch (error: any) {
      console.error('Failed to delete database:', error);
      toast.error(error.response?.data?.error || 'Failed to delete Supabase database');
    } finally {
      setIsDeletingDb(false);
    }
  };

  return (
    <div className="h-full bg-surface-base text-content flex">
      {/* Left Sidebar Navigation */}
      <div className="w-48 border-r border-border p-4 flex-shrink-0">
        <h2 className="text-sm font-semibold text-content-secondary uppercase tracking-wider mb-4">Settings</h2>
        <nav className="space-y-1">
          <button
            onClick={() => setActiveTab('secrets')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
              activeTab === 'secrets'
                ? 'bg-surface text-content'
                : 'text-content-secondary hover:text-content hover:bg-surface/50'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            Secrets
          </button>
          <button
            onClick={() => setActiveTab('supabase')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
              activeTab === 'supabase'
                ? 'bg-surface text-content'
                : 'text-content-secondary hover:text-content hover:bg-surface/50'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
            Supabase
            {supabaseLinked && (
              <svg className="w-3 h-3 text-accent-green ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
          <button
            onClick={() => setActiveTab('ai_provider')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
              activeTab === 'ai_provider'
                ? 'bg-surface text-content'
                : 'text-content-secondary hover:text-content hover:bg-surface/50'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 00.659 1.591L19 14.5M14.25 3.104c.251.023.501.05.75.082M19 14.5l-2.47 2.47a2.25 2.25 0 01-1.59.659H9.06a2.25 2.25 0 01-1.59-.659L5 14.5m14 0V17a2 2 0 01-2 2H7a2 2 0 01-2-2v-2.5" />
            </svg>
            AI Provider
            {activeProvider && (
              <svg className="w-3 h-3 text-accent-green ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
          <button
            onClick={() => setActiveTab('usage')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
              activeTab === 'usage'
                ? 'bg-surface text-content'
                : 'text-content-secondary hover:text-content hover:bg-surface/50'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            Usage
            {usageSummary && usageSummary.limitReached && (
              <span className="ml-auto text-xs text-accent-red">!</span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('general')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
              activeTab === 'general'
                ? 'bg-surface text-content'
                : 'text-content-secondary hover:text-content hover:bg-surface/50'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            General
          </button>
          {isTauri && (
            <button
              onClick={() => setActiveTab('deployment')}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                activeTab === 'deployment'
                  ? 'bg-surface text-content'
                  : 'text-content-secondary hover:text-content hover:bg-surface/50'
              }`}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              Deployment
              {deployConfigured && (
                <svg className="w-3 h-3 text-accent-green ml-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          )}
        </nav>
      </div>

      {/* Right Content Area */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Secrets Tab */}
        {activeTab === 'secrets' && (
          <div>
            <h2 className="text-xl font-semibold mb-6">Environment Variables</h2>

            {/* Detected Integrations Panel - only show if integrations detected */}
            {!loadingIntegrations && integrations.length > 0 && (
              <div className="mb-6 border border-border rounded-lg p-4 bg-surface/50">
                <h3 className="text-sm font-semibold text-content mb-3 flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  Detected Integrations
                </h3>
                <div className="flex flex-wrap gap-2">
                  {integrations.map((integration) => (
                    <div
                      key={integration.id}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm ${
                        integration.missingCount > 0
                          ? 'bg-accent-yellow/10 border border-accent-yellow/50'
                          : 'bg-accent-green/10 border border-accent-green/50'
                      }`}
                    >
                      {integration.missingCount > 0 ? (
                        <svg className="w-4 h-4 text-accent-yellow" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      <span className={integration.missingCount > 0 ? 'text-accent-yellow' : 'text-accent-green'}>
                        {integration.name}
                      </span>
                      {integration.missingCount > 0 && (
                        <span className="text-accent-yellow text-xs">
                          ({integration.missingCount} missing)
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Missing variables section */}
                {missingVars.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-border">
                    <h4 className="text-sm font-medium text-accent-yellow mb-2">Missing Required Variables</h4>
                    <div className="space-y-2">
                      {missingVars.map((missingVar) => (
                        <div
                          key={missingVar.key}
                          className="flex items-center justify-between bg-surface-base rounded px-3 py-2"
                        >
                          <div className="flex items-center gap-2">
                            <code className="text-accent-yellow font-mono text-sm">{missingVar.key}</code>
                            <span className="text-content-tertiary text-xs">
                              for {missingVar.integrationName}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <a
                              href={missingVar.docsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent-blue hover:text-accent-blue text-xs"
                            >
                              Docs
                            </a>
                            <button
                              onClick={() => handleQuickAddVar(missingVar.key)}
                              className="px-2 py-1 bg-accent-blue hover:bg-accent-blue text-content rounded text-xs font-medium transition-colors"
                            >
                              Add
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Environment Variables Section */}
            <div className="border border-border rounded-lg p-6 bg-surface/50">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-content">Environment Variables</h3>
              <p className="text-content-secondary text-sm mt-1">
                Configure environment variables for your project deployments
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setShowImportModal(true)}
                className="px-3 py-1.5 bg-surface-overlay hover:bg-surface-overlay text-content rounded text-sm font-medium transition-colors"
              >
                Import from .env
              </button>
              <button
                onClick={() => {
                  resetSecretForm();
                  setShowAddSecretForm(true);
                }}
                className="px-3 py-1.5 bg-accent-blue hover:bg-accent-blue text-content rounded text-sm font-medium transition-colors"
              >
                Add Variable
              </button>
            </div>
          </div>

          {/* Loading State */}
          {loadingSecrets && (
            <div className="text-content-secondary text-sm py-4 text-center">Loading variables...</div>
          )}

          {/* Empty State */}
          {!loadingSecrets && secrets.length === 0 && !showAddSecretForm && (
            <div className="text-content-tertiary text-sm py-8 text-center border border-dashed border-border-strong rounded-lg">
              No environment variables configured yet.
              <br />
              <button
                onClick={() => {
                  resetSecretForm();
                  setShowAddSecretForm(true);
                }}
                className="text-accent-blue hover:underline mt-2 inline-block"
              >
                Add your first variable
              </button>
            </div>
          )}

          {/* Add/Edit Form */}
          {(showAddSecretForm || editingSecretId) && (
            <div className="bg-surface-base rounded-lg p-4 mb-4 border border-border-strong">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm text-content-secondary mb-1">Key</label>
                  <input
                    type="text"
                    value={secretKey}
                    onChange={(e) => setSecretKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                    placeholder="DATABASE_URL"
                    className="w-full px-3 py-2 bg-surface border border-border-strong rounded focus:outline-none focus:border-accent-blue text-content font-mono text-sm"
                    disabled={isSavingSecret}
                  />
                </div>
                <div>
                  <label className="block text-sm text-content-secondary mb-1">Value</label>
                  <input
                    type={isSecretFlag ? 'password' : 'text'}
                    value={secretValue}
                    onChange={(e) => setSecretValue(e.target.value)}
                    placeholder={editingSecretId ? '(leave empty to keep current)' : 'postgres://...'}
                    className="w-full px-3 py-2 bg-surface border border-border-strong rounded focus:outline-none focus:border-accent-blue text-content font-mono text-sm"
                    disabled={isSavingSecret}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-content-secondary">
                  <input
                    type="checkbox"
                    checked={isSecretFlag}
                    onChange={(e) => setIsSecretFlag(e.target.checked)}
                    className="rounded border-border-strong bg-surface text-accent-blue focus:ring-accent-blue"
                    disabled={isSavingSecret}
                  />
                  Mask value (sensitive)
                </label>

                <div className="flex gap-2">
                  <button
                    onClick={resetSecretForm}
                    className="px-3 py-1.5 bg-surface-elevated hover:bg-surface-overlay text-content rounded text-sm font-medium transition-colors"
                    disabled={isSavingSecret}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={editingSecretId ? handleUpdateSecret : handleAddSecret}
                    disabled={isSavingSecret || !secretKey.trim()}
                    className="px-3 py-1.5 bg-accent-blue hover:bg-accent-blue text-content rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSavingSecret ? 'Saving...' : editingSecretId ? 'Update' : 'Add'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Secrets Table */}
          {!loadingSecrets && secrets.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-3 text-content-secondary font-medium">Key</th>
                    <th className="text-left py-2 px-3 text-content-secondary font-medium">Value</th>
                    <th className="text-right py-2 px-3 text-content-secondary font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {secrets.map((secret) => {
                    const isRevealed = !!revealedSecrets[secret.id];
                    const isRevealing = !!revealingSecrets[secret.id];
                    const isCopying = !!copyingSecrets[secret.id];

                    return (
                      <tr key={secret.id} className="border-b border-border/50 hover:bg-surface/50">
                        <td className="py-2 px-3 font-mono text-accent-blue">{secret.key}</td>
                        <td className="py-2 px-3 font-mono text-content-secondary">
                          {secret.isSecret ? (
                            isRevealed ? (
                              <span className="text-accent-green break-all max-w-xs inline-block">{revealedSecrets[secret.id]}</span>
                            ) : (
                              <span className="text-content-tertiary">{'*'.repeat(12)}</span>
                            )
                          ) : (
                            <span className="truncate max-w-xs inline-block">{secret.value}</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          {/* Reveal button - only for secrets */}
                          {secret.isSecret && (
                            <button
                              onClick={() => handleRevealToggle(secret)}
                              className="text-content-secondary hover:text-content text-sm mr-2 inline-flex items-center"
                              disabled={isRevealing}
                              title={isRevealed ? 'Hide value' : 'Reveal value'}
                            >
                              {isRevealing ? (
                                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                </svg>
                              ) : isRevealed ? (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                </svg>
                              ) : (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                              )}
                            </button>
                          )}
                          {/* Copy button */}
                          <button
                            onClick={() => handleCopySecret(secret)}
                            className="text-content-secondary hover:text-content text-sm mr-2 inline-flex items-center"
                            disabled={isCopying}
                            title="Copy value"
                          >
                            {isCopying ? (
                              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                              </svg>
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                              </svg>
                            )}
                          </button>
                          <button
                            onClick={() => handleEditSecret(secret)}
                            className="text-accent-blue hover:text-accent-blue text-sm mr-2"
                            disabled={editingSecretId === secret.id}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setDeleteSecretId(secret.id)}
                            className="text-accent-red hover:text-accent-red text-sm"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
            </div>
          </div>
        )}

        {/* Supabase Tab */}
        {activeTab === 'supabase' && (
          <div>
            <h2 className="text-xl font-semibold mb-6">Supabase Integration</h2>

            {loadingSupabase ? (
              <div className="text-content-secondary text-sm">Loading...</div>
            ) : !supabaseStatus?.connected ? (
              /* Disconnected state — token input */
              <div className="border border-border rounded-lg p-6 bg-surface/50">
                <div className="text-center mb-4">
                  <svg className="w-12 h-12 mx-auto mb-4 text-content-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
                  </svg>
                  <h3 className="text-lg font-medium mb-2">Connect Supabase</h3>
                  <p className="text-content-secondary text-sm">
                    Link a Supabase project to get a managed Postgres database, auth, and storage for your app.
                  </p>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm text-content-secondary mb-1">
                      Access Token <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noopener noreferrer" className="text-accent-blue hover:text-accent-blue">(generate here)</a>
                    </label>
                    <input
                      type="password"
                      value={supabaseToken}
                      onChange={(e) => setSupabaseToken(e.target.value)}
                      placeholder="sbp_..."
                      className="w-full bg-surface-base border border-border-strong rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-accent-green"
                    />
                  </div>
                  <button
                    onClick={handleConnectSupabase}
                    disabled={connectingSupabase || !supabaseToken.trim()}
                    className="w-full px-4 py-2 bg-accent-green hover:bg-accent-green/80 disabled:bg-surface-elevated disabled:text-content-tertiary text-content rounded-lg text-sm font-medium transition-colors"
                  >
                    {connectingSupabase ? 'Connecting...' : 'Connect'}
                  </button>
                </div>
              </div>
            ) : (
              /* Connected state */
              <div className="space-y-6">
                {/* Account info */}
                <div className="border border-border rounded-lg p-4 bg-surface/50 flex items-center justify-between">
                  <div>
                    <div className="text-sm text-content-secondary">Connected as</div>
                    <div className="font-medium">{supabaseStatus.email || 'Supabase User'}</div>
                  </div>
                  <button
                    onClick={handleDisconnectSupabase}
                    className="px-3 py-1.5 text-sm text-accent-red hover:text-accent-red hover:bg-accent-red/10 rounded transition-colors"
                  >
                    Disconnect
                  </button>
                </div>

                {/* Linked project or picker */}
                {supabaseLinked ? (
                  <div className="border border-accent-green rounded-lg p-4 bg-accent-green/10">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-accent-green">Linked Project</h3>
                      <div className="flex gap-2">
                        <button
                          onClick={handleUnlinkSupabase}
                          className="px-3 py-1 text-xs text-accent-red hover:text-accent-red hover:bg-accent-red/10 rounded transition-colors"
                        >
                          Unlink
                        </button>
                        <button
                          onClick={() => { setShowDeleteDbDialog(true); setDbConfirmName(''); }}
                          className="px-3 py-1 text-xs text-accent-red hover:text-accent-red bg-accent-red/10 hover:bg-accent-red/20 rounded transition-colors border border-accent-red/50"
                        >
                          Delete Database
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1 text-sm">
                      <div><span className="text-content-secondary">Name:</span> {supabaseLinked.supabase_project_name}</div>
                      <div><span className="text-content-secondary">Ref:</span> <span className="font-mono text-xs">{supabaseLinked.supabase_project_ref}</span></div>
                      <div><span className="text-content-secondary">Region:</span> {supabaseLinked.region || 'N/A'}</div>
                      <div><span className="text-content-secondary">URL:</span> <span className="font-mono text-xs text-accent-blue">{supabaseLinked.supabase_url}</span></div>
                    </div>
                    <p className="text-xs text-content-tertiary mt-3">
                      Secrets SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY were auto-created.
                    </p>
                  </div>
                ) : (
                  <div className="border border-border rounded-lg p-4 bg-surface/50">
                    <h3 className="text-sm font-semibold mb-3">Link a Supabase Project</h3>
                    {supabaseProjects.length === 0 ? (
                      <p className="text-content-secondary text-sm">No Supabase projects found. Create one at supabase.com first.</p>
                    ) : (
                      <div className="space-y-3">
                        <select
                          value={selectedSupabaseProject}
                          onChange={(e) => setSelectedSupabaseProject(e.target.value)}
                          className="w-full bg-surface-base border border-border-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent-green"
                        >
                          <option value="">Select a project...</option>
                          {supabaseProjects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.region})
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={handleLinkSupabase}
                          disabled={!selectedSupabaseProject || linkingSupabase}
                          className="px-4 py-2 bg-accent-green hover:bg-accent-green/80 disabled:bg-surface-elevated disabled:text-content-tertiary text-content rounded-lg text-sm font-medium transition-colors"
                        >
                          {linkingSupabase ? 'Linking...' : 'Link Project'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Deployment Tab (Desktop-only) */}
        {activeTab === 'deployment' && isTauri && (
          <div>
            <h2 className="text-xl font-semibold mb-6">Vercel Deployment</h2>

            <div className="border border-border rounded-lg p-6 bg-surface/50 space-y-6">
              {/* Status indicator */}
              {deployConfigured && (
                <div className="flex items-center gap-3 p-3 bg-accent-green/10 border border-accent-green/30 rounded-lg">
                  <svg className="w-5 h-5 text-accent-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div>
                    <span className="text-accent-green font-medium">Vercel connected</span>
                    {deployUsername && (
                      <span className="text-accent-green/70 text-sm ml-2">({deployUsername})</span>
                    )}
                  </div>
                </div>
              )}

              {/* Description */}
              <div>
                <p className="text-content-secondary text-sm">
                  Atlas deploys to Vercel using your account. Even if the Vercel CLI is installed locally, Atlas still needs a personal access token once so it can create deployments for you from inside the app.
                </p>
              </div>

              <div className="rounded-lg border border-accent-blue/30 bg-accent-blue/10 p-4 space-y-3">
                <div className="text-sm font-medium text-accent-blue">Fastest setup</div>
                <ol className="space-y-2 text-sm text-content list-decimal list-inside">
                  <li>Open Vercel token settings and create a new Personal Access Token.</li>
                  <li>Paste it below and click <span className="font-medium text-content">Test &amp; Save</span>.</li>
                  <li>Leave Team ID blank unless you deploy into a Vercel team.</li>
                </ol>
                <div className="flex flex-wrap gap-2">
                  <a
                    href="https://vercel.com/account/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 bg-accent-blue hover:bg-accent-blue text-content rounded text-sm font-medium transition-colors inline-flex items-center gap-2"
                  >
                    Open Token Page
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                  <a
                    href="https://vercel.com/teams"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 bg-surface-elevated hover:bg-surface-overlay text-content rounded text-sm font-medium transition-colors inline-flex items-center gap-2"
                  >
                    Open Team Settings
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
                <p className="text-xs text-accent-blue/80">
                  Personal account: leave Team ID empty. Team account: paste the team ID after the token is working.
                </p>
              </div>

              {/* Token input */}
              <div>
                <label className="block text-sm text-content-secondary mb-1">Personal Access Token</label>
                <div className="relative">
                  <input
                    type={showDeployToken ? 'text' : 'password'}
                    value={deployToken}
                    onChange={(e) => setDeployToken(e.target.value)}
                    placeholder={deployConfigured ? '(token saved — enter new token to update)' : 'Paste your Vercel token'}
                    className="w-full px-3 py-2 pr-10 bg-surface-base border border-border-strong rounded focus:outline-none focus:border-accent-blue text-content font-mono text-sm"
                    disabled={isSavingDeploy}
                  />
                  <button
                    type="button"
                    onClick={() => setShowDeployToken(!showDeployToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-content-secondary hover:text-content"
                    title={showDeployToken ? 'Hide token' : 'Show token'}
                  >
                    {showDeployToken ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {/* Team ID input (optional) */}
              <div>
                <label className="block text-sm text-content-secondary mb-1">
                  Team ID <span className="text-content-tertiary">(optional)</span>
                </label>
                <input
                  type="text"
                  value={deployTeamId}
                  onChange={(e) => setDeployTeamId(e.target.value)}
                  placeholder={deployHasTeamId ? '(team ID saved — enter new to update)' : 'team_xxx (leave empty for personal account)'}
                  className="w-full px-3 py-2 bg-surface-base border border-border-strong rounded focus:outline-none focus:border-accent-blue text-content font-mono text-sm"
                  disabled={isSavingDeploy}
                />
                <p className="text-content-tertiary text-xs mt-1">
                  Only needed if the project should deploy into a Vercel team. Most users should leave this empty.
                </p>
              </div>

              {/* Save button */}
              <button
                onClick={handleSaveDeploySettings}
                disabled={isSavingDeploy || !deployToken.trim()}
                className="px-4 py-2 bg-accent-blue hover:bg-accent-blue text-content rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isSavingDeploy ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Validating...
                  </>
                ) : (
                  'Test & Save'
                )}
              </button>
            </div>
          </div>
        )}

        {/* AI Provider Tab */}
        {activeTab === 'ai_provider' && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold">AI Provider</h2>
              <button
                onClick={handleScanProviders}
                disabled={isScanning}
                className="px-3 py-1.5 text-sm bg-surface-elevated hover:bg-surface-overlay rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <svg className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {isScanning ? 'Scanning...' : 'Re-scan for tools'}
              </button>
            </div>

            <p className="text-sm text-content-secondary mb-6">
              AtlasEngine uses an AI provider to review code changes. It can auto-detect credentials from installed CLI tools, or you can add an API key manually.
            </p>

            {/* Active Provider */}
            {activeProvider && (
              <div className="mb-6 p-4 bg-accent-green/10 border border-accent-green/30 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-accent-green animate-pulse" />
                  <div>
                    <div className="text-sm font-medium text-accent-green">Active: {activeProvider.label}</div>
                    <div className="text-xs text-accent-green/70">Model: {activeProvider.model}</div>
                  </div>
                </div>
              </div>
            )}

            {!activeProvider && !loadingProviders && (
              <div className="mb-6 p-4 bg-accent-yellow/10 border border-accent-yellow/30 rounded-lg">
                <div className="text-sm text-accent-yellow">No active AI provider. Reviews require a configured provider.</div>
                <div className="text-xs text-accent-yellow/70 mt-1">Add an API key below or scan for installed CLI tools.</div>
              </div>
            )}

            {/* Detected Providers */}
            {loadingProviders ? (
              <div className="text-sm text-content-tertiary">Loading providers...</div>
            ) : (
              <>
                {providers.length > 0 && (
                  <div className="mb-6">
                    <h3 className="text-sm font-semibold text-content-secondary uppercase tracking-wider mb-3">Configured Providers</h3>
                    <div className="space-y-2">
                      {providers.map((provider) => (
                        <div key={provider.id} className="flex items-center justify-between p-3 bg-surface rounded-lg border border-border">
                          <div className="flex items-center gap-3">
                            <div className={`w-2 h-2 rounded-full ${
                              provider.status === 'connected' ? 'bg-accent-green' :
                              provider.status === 'needs_key' ? 'bg-accent-yellow' :
                              provider.status === 'error' ? 'bg-accent-red' :
                              provider.status === 'expired' ? 'bg-accent-yellow' :
                              'bg-surface-overlay'
                            }`} />
                            <div>
                              <div className="text-sm font-medium">{provider.label}</div>
                              <div className="text-xs text-content-tertiary">
                                {provider.model} &middot; {provider.source === 'cli_detected' ? 'Auto-detected' : 'API Key'}
                                {provider.error && <span className={`ml-2 ${provider.status === 'needs_key' ? 'text-accent-yellow' : 'text-accent-red'}`}>{provider.error}</span>}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {!provider.isActive && isProviderUsable(provider) && (
                              <button
                                onClick={() => handleSetActiveProvider(provider.id)}
                                className="px-2 py-1 text-xs bg-accent-blue hover:bg-accent-blue rounded transition-colors"
                              >
                                Use
                              </button>
                            )}
                            {provider.isActive && (
                              <span className="px-2 py-1 text-xs bg-accent-green/30 text-accent-green rounded">Active</span>
                            )}
                            {provider.source === 'byok' && (
                              <button
                                onClick={() => handleRemoveProvider(provider.id)}
                                className="p-1 text-content-tertiary hover:text-accent-red transition-colors"
                                title="Remove"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Add Provider Form */}
                {!showAddProvider ? (
                  <button
                    onClick={() => setShowAddProvider(true)}
                    className="w-full p-3 border border-dashed border-border-strong rounded-lg text-sm text-content-secondary hover:text-content hover:border-border-strong transition-colors"
                  >
                    + Add API Key
                  </button>
                ) : (
                  <div className="p-4 bg-surface rounded-lg border border-border">
                    <h3 className="text-sm font-semibold mb-4">Add API Key</h3>

                    {/* Provider Type */}
                    <div className="mb-4">
                      <label className="block text-xs text-content-secondary mb-1.5">Provider</label>
                      <select
                        value={byokType}
                        onChange={(e) => {
                          setByokType(e.target.value);
                          setByokModel('');
                          setTestResult(null);
                        }}
                        className="w-full px-3 py-2 bg-surface-elevated border border-border-strong rounded-lg text-sm focus:border-accent-blue focus:outline-none"
                      >
                        {providerConfigs.filter(c => c.byokEligible !== false).map((config) => (
                          <option key={config.type} value={config.type}>{config.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* API Key */}
                    <div className="mb-4">
                      <label className="block text-xs text-content-secondary mb-1.5">API Key</label>
                      <input
                        type="password"
                        value={byokApiKey}
                        onChange={(e) => { setByokApiKey(e.target.value); setTestResult(null); }}
                        placeholder={byokType === 'anthropic' ? 'sk-ant-...' : byokType === 'google' ? 'AIza...' : 'sk-...'}
                        className="w-full px-3 py-2 bg-surface-elevated border border-border-strong rounded-lg text-sm font-mono focus:border-accent-blue focus:outline-none"
                      />
                    </div>

                    {/* Model Selector */}
                    <div className="mb-4">
                      <label className="block text-xs text-content-secondary mb-1.5">Model</label>
                      <select
                        value={byokModel || providerConfigs.find(c => c.type === byokType)?.defaultModel || ''}
                        onChange={(e) => setByokModel(e.target.value)}
                        className="w-full px-3 py-2 bg-surface-elevated border border-border-strong rounded-lg text-sm focus:border-accent-blue focus:outline-none"
                      >
                        {providerConfigs.find(c => c.type === byokType)?.models.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* Test Result */}
                    {testResult && (
                      <div className={`mb-4 p-3 rounded-lg text-sm ${
                        testResult.success
                          ? 'bg-accent-green/10 border border-accent-green/30 text-accent-green'
                          : 'bg-accent-red/10 border border-accent-red/30 text-accent-red'
                      }`}>
                        {testResult.success
                          ? `Connected (${testResult.latencyMs}ms)`
                          : `Failed: ${testResult.error}`
                        }
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleTestConnection}
                        disabled={isTesting || !byokApiKey.trim()}
                        className="px-3 py-2 text-sm bg-surface-overlay hover:bg-surface-overlay rounded-lg transition-colors disabled:opacity-50"
                      >
                        {isTesting ? 'Testing...' : 'Test Connection'}
                      </button>
                      <button
                        onClick={handleAddProvider}
                        disabled={isSavingProvider || !byokApiKey.trim()}
                        className="px-3 py-2 text-sm bg-accent-blue hover:bg-accent-blue rounded-lg transition-colors disabled:opacity-50"
                      >
                        {isSavingProvider ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setShowAddProvider(false); setByokApiKey(''); setTestResult(null); }}
                        className="px-3 py-2 text-sm text-content-secondary hover:text-content transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Branch auto-review toggle */}
                <div className="mt-6 p-4 bg-surface rounded-lg border border-border">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">Auto-review branch reviews</div>
                      <div className="text-xs text-content-tertiary mt-0.5">
                        Automatically trigger AI review when Atlas detects branch review changes
                      </div>
                    </div>
                    <button
                      onClick={handleAutoReviewToggle}
                      disabled={loadingAutoReview || !activeProvider}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        autoReviewEnabled ? 'bg-accent-blue' : 'bg-surface-overlay'
                      } ${(!activeProvider || loadingAutoReview) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                      title={!activeProvider ? 'Configure an AI provider first' : undefined}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-surface-raised transition-transform ${
                          autoReviewEnabled ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                  {!activeProvider && (
                    <div className="text-xs text-accent-yellow/70 mt-2">Requires an active AI provider</div>
                  )}
                </div>

                {/* Require checks before publish toggle */}
                <div className="mt-4 p-4 bg-surface rounded-lg border border-border">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium">Require verification before publish</div>
                      <div className="text-xs text-content-tertiary mt-0.5">
                        When enabled, all available checks must pass before publishing. Disable to allow publishing without verification.
                      </div>
                    </div>
                    <button
                      onClick={handleRequireChecksToggle}
                      disabled={loadingRequireChecks}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        requireChecksBeforePublish ? 'bg-accent-blue' : 'bg-surface-overlay'
                      } ${loadingRequireChecks ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-surface-raised transition-transform ${
                          requireChecksBeforePublish ? 'translate-x-6' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Privacy Note */}
                <div className="mt-6 p-3 bg-surface/50 rounded-lg">
                  <div className="text-xs text-content-tertiary">
                    <strong className="text-content-secondary">Privacy:</strong> API keys are encrypted locally (AES-256-GCM). Code diffs are sent to the selected provider for review. No data is stored on Atlas servers.
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Usage Tab */}
        {activeTab === 'usage' && (
          <div>
            <h2 className="text-xl font-semibold mb-6">Usage & Limits</h2>

            {loadingUsage ? (
              <div className="space-y-4">
                <div className="h-24 bg-surface rounded-lg animate-pulse" />
                <div className="h-32 bg-surface rounded-lg animate-pulse" />
              </div>
            ) : (
              <>
                {/* Monthly Summary Card */}
                {usageSummary && (
                  <div className="mb-6 border border-border rounded-lg p-6 bg-surface/50">
                    <h3 className="text-sm font-semibold text-content-secondary uppercase tracking-wider mb-4">This Month</h3>

                    {/* Progress bar */}
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-sm text-content">
                          {usageSummary.reviewCount} / {usageSummary.monthlyLimit} reviews
                        </span>
                        <span className={`text-xs font-medium ${
                          usageSummary.limitReached ? 'text-accent-red' :
                          usageSummary.reviewsRemaining <= 5 ? 'text-accent-yellow' :
                          'text-accent-green'
                        }`}>
                          {usageSummary.limitReached ? 'Limit reached' : `${usageSummary.reviewsRemaining} remaining`}
                        </span>
                      </div>
                      <div className="w-full h-2 bg-surface-elevated rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            usageSummary.limitReached ? 'bg-accent-red' :
                            usageSummary.reviewsRemaining <= 5 ? 'bg-accent-yellow' :
                            'bg-accent-blue'
                          }`}
                          style={{ width: `${Math.min(100, (usageSummary.reviewCount / usageSummary.monthlyLimit) * 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* Stats row */}
                    <div className="grid grid-cols-3 gap-4">
                      <div className="bg-surface-base rounded-lg p-3">
                        <div className="text-xs text-content-tertiary mb-1">Total Tokens</div>
                        <div className="text-lg font-semibold text-content">
                          {usageSummary.totalTokens > 1000
                            ? `${(usageSummary.totalTokens / 1000).toFixed(1)}K`
                            : usageSummary.totalTokens}
                        </div>
                      </div>
                      <div className="bg-surface-base rounded-lg p-3">
                        <div className="text-xs text-content-tertiary mb-1">Est. Cost</div>
                        <div className="text-lg font-semibold text-content">
                          ${usageSummary.totalCost.toFixed(4)}
                        </div>
                      </div>
                      <div className="bg-surface-base rounded-lg p-3">
                        <div className="text-xs text-content-tertiary mb-1">Reviews</div>
                        <div className="text-lg font-semibold text-content">
                          {usageSummary.reviewCount}
                        </div>
                      </div>
                    </div>

                    {usageSummary.limitReached && (
                      <div className="mt-4 p-3 bg-accent-red/10 border border-accent-red/30 rounded-lg">
                        <div className="text-sm text-accent-red">
                          You've reached the free tier limit of {usageSummary.monthlyLimit} reviews this month.
                          Your limit resets at the start of next month.
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Provider Breakdown */}
                {usageBreakdown.length > 0 && (
                  <div className="mb-6 border border-border rounded-lg p-6 bg-surface/50">
                    <h3 className="text-sm font-semibold text-content-secondary uppercase tracking-wider mb-3">By Provider</h3>
                    <div className="space-y-2">
                      {usageBreakdown.map((entry, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 bg-surface-base rounded-lg">
                          <div>
                            <div className="text-sm font-medium text-content">{entry.model}</div>
                            <div className="text-xs text-content-tertiary">{entry.providerType} &middot; {entry.reviewCount} reviews</div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-medium text-content">${entry.totalCost.toFixed(4)}</div>
                            <div className="text-xs text-content-tertiary">
                              {entry.totalTokens > 1000
                                ? `${(entry.totalTokens / 1000).toFixed(1)}K tokens`
                                : `${entry.totalTokens} tokens`}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Recent Reviews */}
                <div className="border border-border rounded-lg p-6 bg-surface/50">
                  <h3 className="text-sm font-semibold text-content-secondary uppercase tracking-wider mb-3">Recent Reviews</h3>
                  {usageRecords.length === 0 ? (
                    <div className="text-content-tertiary text-sm py-6 text-center border border-dashed border-border-strong rounded-lg">
                      No reviews yet this month. Reviews will appear here once you start using AI code review.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-2 px-3 text-content-secondary font-medium">Date</th>
                            <th className="text-left py-2 px-3 text-content-secondary font-medium">Model</th>
                            <th className="text-right py-2 px-3 text-content-secondary font-medium">Tokens</th>
                            <th className="text-right py-2 px-3 text-content-secondary font-medium">Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {usageRecords.map((record) => (
                            <tr key={record.id} className="border-b border-border/50 hover:bg-surface/50">
                              <td className="py-2 px-3 text-content">
                                {new Date(record.reviewedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </td>
                              <td className="py-2 px-3 text-content-secondary font-mono text-xs">{record.model}</td>
                              <td className="py-2 px-3 text-right text-content">
                                {record.totalTokens > 1000
                                  ? `${(record.totalTokens / 1000).toFixed(1)}K`
                                  : record.totalTokens}
                              </td>
                              <td className="py-2 px-3 text-right text-content">${record.estimatedCost.toFixed(4)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Pricing note */}
                <div className="mt-6 p-3 bg-surface/50 rounded-lg">
                  <div className="text-xs text-content-tertiary">
                    <strong className="text-content-secondary">Free tier:</strong> {usageSummary?.monthlyLimit || 20} AI reviews per month.
                    Cost estimates are based on published API pricing and may not reflect your actual billing.
                    Token usage is tracked locally — no data is sent to Atlas servers.
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* General Tab */}
        {activeTab === 'general' && (
          <div>
            <h2 className="text-xl font-semibold mb-6">General Settings</h2>

            {/* Project Name */}
            <div className="mb-8">
              <label className="block text-sm font-medium text-content-secondary mb-2">Project Name</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={50}
                  className="flex-1 px-3 py-2 rounded-lg bg-surface border border-border text-content text-sm focus:outline-none focus:border-accent-blue"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                />
                <button
                  onClick={async () => {
                    const trimmed = editName.trim();
                    if (!trimmed || trimmed === projectName) return;
                    setIsSavingName(true);
                    try {
                      await projectApi.update(projectId, { name: trimmed.slice(0, 50) });
                      onProjectRenamed?.(projectId, trimmed.slice(0, 50));
                      toast.success('Project renamed');
                    } catch {
                      toast.error('Failed to rename project');
                      setEditName(projectName);
                    } finally {
                      setIsSavingName(false);
                    }
                  }}
                  disabled={isSavingName || !editName.trim() || editName.trim() === projectName}
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-accent-blue text-white hover:bg-accent-blue/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {isSavingName ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>

            {/* Hosting Section - only show if hosting is configured */}
            {!loadingHosting && hosting && (
              <div className="mb-8 border border-orange-900 rounded-lg p-6 bg-orange-950/20">
                <h3 className="text-lg font-semibold text-orange-400 mb-2">Hosting Management</h3>
            <p className="text-content-secondary text-sm mb-4">
              Manage your published site at <span className="font-mono text-orange-300">{hosting.customDomain}</span>
            </p>

            {hosting.lastDeploymentUrl && (
              <div className="text-content-secondary text-sm mb-4">
                <span className="text-content-tertiary">Last deployment:</span>{' '}
                <a
                  href={hosting.lastDeploymentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-blue hover:underline"
                >
                  {hosting.lastDeploymentUrl}
                </a>
              </div>
            )}

            <div className="space-y-4">
              {/* Disable Production URL */}
              <div className="flex items-start gap-4">
                <button
                  onClick={() => setShowDisableDomainDialog(true)}
                  className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-content rounded font-medium transition-colors whitespace-nowrap"
                >
                  Disable Production URL
                </button>
                <p className="text-content-tertiary text-sm">
                  Remove the custom domain. Your app will become inaccessible at {hosting.customDomain}, but the Vercel project and deployment history remain.
                </p>
              </div>

              {/* Delete Hosting Resources */}
              <div className="flex items-start gap-4">
                <button
                  onClick={() => {
                    setShowDeleteHostingDialog(true);
                    setHostingConfirmSlug('');
                  }}
                  className="px-4 py-2 bg-accent-red hover:bg-accent-red/80 text-content rounded font-medium transition-colors whitespace-nowrap"
                >
                  Delete Hosting Resources
                </button>
                <p className="text-content-tertiary text-sm">
                  Permanently delete the Vercel project, all deployments, and domain configurations. This cannot be undone.
                </p>
              </div>
              </div>
            </div>
            )}

            {/* Storage Management */}
            <div className="mb-8 border border-border rounded-lg p-6 bg-surface/30">
              <h3 className="text-lg font-semibold text-content mb-2">Storage</h3>
              <p className="text-content-secondary text-sm mb-4">
                Delete uploaded chat attachments (images, documents) to free up disk space. This does not affect chat messages.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={async () => {
                    try {
                      await projectApi.revealAttachments(projectId);
                    } catch {
                      alert('Could not open attachments folder.');
                    }
                  }}
                  className="px-4 py-2 bg-surface-overlay hover:bg-surface-overlay text-content rounded font-medium transition-colors"
                >
                  Show Attachments
                </button>
                <button
                  onClick={async () => {
                    if (!confirm('Delete all uploaded attachments for this project?')) return;
                    try {
                      const result = await projectApi.deleteAttachments(projectId);
                      alert(result.count > 0 ? `Deleted ${result.count} attachment(s).` : 'No attachments to delete.');
                    } catch {
                      alert('Failed to delete attachments.');
                    }
                  }}
                  className="px-4 py-2 bg-accent-red/80 hover:bg-accent-red text-content rounded font-medium transition-colors"
                >
                  Delete Attachments
                </button>
              </div>
            </div>

            {/* Danger Zone */}
            <div className="border border-accent-red rounded-lg p-6 bg-accent-red/10">
              <h3 className="text-lg font-semibold text-accent-red mb-2">Danger Zone</h3>
              <p className="text-content-secondary text-sm mb-4">
                Once you delete a project, there is no going back. This will permanently delete:
              </p>
              <ul className="text-content-secondary text-sm mb-4 list-disc list-inside space-y-1">
                <li>All project files and folders</li>
                <li>Chat history and memory snapshots</li>
                <li>Build history and previews</li>
                <li>Database records</li>
              </ul>
              {hosting && (
                <p className="text-accent-yellow text-sm mb-4 bg-accent-yellow/10 p-3 rounded border border-accent-yellow/50">
                  Note: Hosting resources will remain unless you delete them separately above.
                </p>
              )}
              <button
                onClick={handleDeleteClick}
                className="px-4 py-2 bg-accent-red hover:bg-accent-red/80 text-content rounded font-medium transition-colors"
              >
                Delete Project
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Delete Project Confirmation Dialog */}
      {showDeleteDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface rounded-lg p-6 max-w-md w-full mx-4 border border-border">
            <h3 className="text-xl font-semibold mb-4 text-accent-red">
              Delete Project
            </h3>

            <p className="text-content mb-4">
              This action <span className="font-semibold text-accent-red">cannot be undone</span>.
              This will permanently delete the project and all associated data.
            </p>

            {hosting && (
              <p className="text-accent-yellow text-sm mb-4 bg-accent-yellow/10 p-3 rounded">
                Hosting resources at {hosting.customDomain} will remain active. Delete them separately if needed.
              </p>
            )}

            <p className="text-content mb-2">
              Please type <span className="font-mono bg-surface-base px-2 py-1 rounded">{projectName}</span> to confirm:
            </p>

            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="w-full px-3 py-2 bg-surface-base border border-border-strong rounded focus:outline-none focus:border-accent-blue mb-6"
              placeholder="Type project name"
              autoFocus
              disabled={isDeleting}
            />

            <div className="flex gap-3 justify-end">
              <button
                onClick={handleCancelDelete}
                className="px-4 py-2 bg-surface-elevated hover:bg-surface-overlay text-content rounded font-medium transition-colors"
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={confirmText !== projectName || isDeleting}
                className="px-4 py-2 bg-accent-red hover:bg-accent-red/80 text-content rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDeleting ? 'Deleting...' : 'Delete Project'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Disable Domain Confirmation Dialog */}
      {showDisableDomainDialog && hosting && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface rounded-lg p-6 max-w-md w-full mx-4 border border-border">
            <h3 className="text-xl font-semibold mb-4 text-orange-400">
              Disable Production URL
            </h3>

            <p className="text-content mb-4">
              This will remove the custom domain <span className="font-mono text-orange-300">{hosting.customDomain}</span> from your Vercel project.
            </p>

            <p className="text-content-secondary text-sm mb-4">
              Your app will become inaccessible at this URL, but the Vercel project and deployment history will remain. You can re-enable it by publishing again.
            </p>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDisableDomainDialog(false)}
                className="px-4 py-2 bg-surface-elevated hover:bg-surface-overlay text-content rounded font-medium transition-colors"
                disabled={isDisablingDomain}
              >
                Cancel
              </button>
              <button
                onClick={handleDisableDomain}
                disabled={isDisablingDomain}
                className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-content rounded font-medium transition-colors disabled:opacity-50"
              >
                {isDisablingDomain ? 'Disabling...' : 'Disable URL'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Hosting Confirmation Dialog */}
      {showDeleteHostingDialog && hosting && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface rounded-lg p-6 max-w-md w-full mx-4 border border-border">
            <h3 className="text-xl font-semibold mb-4 text-accent-red">
              Delete Hosting Resources
            </h3>

            <p className="text-content mb-4">
              This action <span className="font-semibold text-accent-red">cannot be undone</span>.
              This will permanently delete:
            </p>

            <ul className="text-content-secondary text-sm mb-4 list-disc list-inside space-y-1">
              <li>Vercel project ({hosting.vercelProjectName})</li>
              <li>All deployments and deployment history</li>
              <li>Custom domain ({hosting.customDomain})</li>
            </ul>

            <p className="text-content mb-2">
              Please type <span className="font-mono bg-surface-base px-2 py-1 rounded">{expectedSlug}</span> to confirm:
            </p>

            <input
              type="text"
              value={hostingConfirmSlug}
              onChange={(e) => setHostingConfirmSlug(e.target.value)}
              className="w-full px-3 py-2 bg-surface-base border border-border-strong rounded focus:outline-none focus:border-accent-red mb-6"
              placeholder="Type project slug"
              autoFocus
              disabled={isDeletingHosting}
            />

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowDeleteHostingDialog(false);
                  setHostingConfirmSlug('');
                }}
                className="px-4 py-2 bg-surface-elevated hover:bg-surface-overlay text-content rounded font-medium transition-colors"
                disabled={isDeletingHosting}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteHosting}
                disabled={hostingConfirmSlug !== expectedSlug || isDeletingHosting}
                className="px-4 py-2 bg-accent-red hover:bg-accent-red/80 text-content rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDeletingHosting ? 'Deleting...' : 'Delete Hosting'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Database Confirmation Dialog */}
      {showDeleteDbDialog && supabaseLinked && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface rounded-lg p-6 max-w-md w-full mx-4 border border-border">
            <h3 className="text-xl font-semibold mb-4 text-accent-red">
              Delete Database
            </h3>

            <p className="text-content mb-4">
              This action <span className="font-semibold text-accent-red">cannot be undone</span>.
              This will permanently delete the Supabase project and all its data:
            </p>

            <ul className="text-content-secondary text-sm mb-4 list-disc list-inside space-y-1">
              <li>Project: {supabaseLinked.supabase_project_name}</li>
              <li>All database tables and data</li>
              <li>Auth users and sessions</li>
              <li>Storage buckets and files</li>
            </ul>

            <p className="text-content mb-2">
              Please type <span className="font-mono bg-surface-base px-2 py-1 rounded">{supabaseLinked.supabase_project_name}</span> to confirm:
            </p>

            <input
              type="text"
              value={dbConfirmName}
              onChange={(e) => setDbConfirmName(e.target.value)}
              className="w-full px-3 py-2 bg-surface-base border border-border-strong rounded focus:outline-none focus:border-accent-red mb-6"
              placeholder="Type project name"
              autoFocus
              disabled={isDeletingDb}
            />

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setShowDeleteDbDialog(false);
                  setDbConfirmName('');
                }}
                className="px-4 py-2 bg-surface-elevated hover:bg-surface-overlay text-content rounded font-medium transition-colors"
                disabled={isDeletingDb}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteDatabase}
                disabled={dbConfirmName !== supabaseLinked.supabase_project_name || isDeletingDb}
                className="px-4 py-2 bg-accent-red hover:bg-accent-red/80 text-content rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDeletingDb ? 'Deleting...' : 'Delete Database'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Secret Confirmation Dialog */}
      {deleteSecretId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface rounded-lg p-6 max-w-md w-full mx-4 border border-border">
            <h3 className="text-xl font-semibold mb-4 text-accent-red">
              Delete Variable
            </h3>

            <p className="text-content mb-6">
              Are you sure you want to delete this environment variable? This action cannot be undone.
            </p>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteSecretId(null)}
                className="px-4 py-2 bg-surface-elevated hover:bg-surface-overlay text-content rounded font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteSecret}
                className="px-4 py-2 bg-accent-red hover:bg-accent-red/80 text-content rounded font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import .env Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface rounded-lg p-6 max-w-lg w-full mx-4 border border-border">
            <h3 className="text-xl font-semibold mb-4 text-content">
              Import from .env
            </h3>

            <p className="text-content-secondary text-sm mb-4">
              Paste the contents of your .env file below. Existing variables with the same key will be updated.
            </p>

            <textarea
              value={importContent}
              onChange={(e) => setImportContent(e.target.value)}
              placeholder={`DATABASE_URL=postgres://...\nAPI_KEY=sk-...\n# Comments are ignored`}
              className="w-full h-48 px-3 py-2 bg-surface-base border border-border-strong rounded focus:outline-none focus:border-accent-blue text-content font-mono text-sm resize-none"
              disabled={isImporting}
            />

            <div className="flex gap-3 justify-end mt-4">
              <button
                onClick={() => {
                  setShowImportModal(false);
                  setImportContent('');
                }}
                className="px-4 py-2 bg-surface-elevated hover:bg-surface-overlay text-content rounded font-medium transition-colors"
                disabled={isImporting}
              >
                Cancel
              </button>
              <button
                onClick={handleImportEnv}
                disabled={isImporting || !importContent.trim()}
                className="px-4 py-2 bg-accent-blue hover:bg-accent-blue text-content rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isImporting ? 'Importing...' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SettingsPanel;
