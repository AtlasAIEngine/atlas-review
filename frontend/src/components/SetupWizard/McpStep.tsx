/**
 * McpStep Component
 * Optional MCP onboarding step shown during desktop first-run setup
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeApiError, getApiBaseUrl, mcpApi, settingsApi } from '@/services/api';
import type {
  McpAgentsResponse,
  McpConfigResponse,
} from '@/services/api';
import { MCP_AUTO_SELECTED_AGENTS_KEY, parseMcpSelectedAgents } from '@/constants/mcpSettings';
import {
  getSetupButtonStyle,
  getSetupIconBadgeStyle,
  getSetupNoticeStyle,
  getSetupOptionCardStyle,
  getSetupTextButtonStyle,
  setupCodeBlockStyle,
  setupInputStyle,
  setupInsetPanelStyle,
} from './setupChrome';
import { SetupButtonIcon } from './setupButtonIcons';
import { isSetupAdvanceKey, shouldIgnoreSetupShortcut } from './setupKeyboard';

interface McpStepProps {
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

export function McpStep({ onNext, onBack, onSkip }: McpStepProps) {
  const [loading, setLoading] = useState(true);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [syncingSelection, setSyncingSelection] = useState(false);
  const [savingSelection, setSavingSelection] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [agents, setAgents] = useState<McpAgentsResponse['detectedAgents']>([]);
  const [startupSelectedAgents, setStartupSelectedAgents] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [config, setConfig] = useState<McpConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backendUrl = useMemo(() => {
    const liveApiBase = String(getApiBaseUrl() || '').trim();
    return liveApiBase || 'http://127.0.0.1:3000/api';
  }, []);
  const selectedAgentRef = useRef(selectedAgent);
  const configRequestIdRef = useRef(0);
  const backendUrlRef = useRef(backendUrl);
  const selectableAgents = useMemo(
    () => agents.filter((entry) => entry.autoWriteSupported),
    [agents]
  );
  const manualOnlyAgents = useMemo(
    () => agents.filter((entry) => !entry.autoWriteSupported),
    [agents]
  );

  const copyToClipboard = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (copyError) {
      console.warn(`Failed to copy ${label.toLowerCase()}:`, copyError);
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
      backendUrlRef.current = backendUrl;
      const [statusResult, agentsResult, startupSelectionResult] = await Promise.allSettled([
        mcpApi.getStatus(backendUrl),
        mcpApi.getAgents(backendUrl),
        settingsApi.get(MCP_AUTO_SELECTED_AGENTS_KEY).catch(() => ({ exists: false, value: null })),
      ]);
      const agentsResponse = agentsResult.status === 'fulfilled' ? agentsResult.value : null;
      const startupSelectionSetting = startupSelectionResult.status === 'fulfilled'
        ? startupSelectionResult.value
        : { exists: false, value: null };
      const nextAgents = agentsResponse?.detectedAgents || [];
      const nextSelectableAgents = nextAgents.filter((entry) => entry.autoWriteSupported);

      setAgents(nextAgents);

      if (nextAgents.length === 0) {
        configRequestIdRef.current += 1;
        setLoadingConfig(false);
        setConfig(null);
      }

      setSelectedAgent((current) => {
        if (current && nextAgents.some((entry) => entry.id === current)) return current;
        // Prefer Codex if detected, then first installed agent, then first agent
        const codex = nextAgents.find((entry) => entry.id === 'codex' && entry.isInstalled);
        const preferred = codex || nextAgents.find((entry) => entry.isInstalled) || nextAgents[0];
        return preferred?.id || '';
      });

      const detectedAgentIdSet = new Set(nextAgents.map((entry) => entry.id));
      const savedSelection = parseMcpSelectedAgents(startupSelectionSetting?.value)
        .filter((id) => detectedAgentIdSet.has(id))
        .filter((id) => nextAgents.some((entry) => entry.id === id && entry.autoWriteSupported));
      const installedSelection = nextSelectableAgents
        .filter((entry) => entry.isInstalled)
        .map((entry) => entry.id);
      const defaultSelection = installedSelection.length > 0
        ? installedSelection
        : (nextSelectableAgents[0] ? [nextSelectableAgents[0].id] : []);
      setStartupSelectedAgents(startupSelectionSetting?.exists ? savedSelection : defaultSelection);

      if (statusResult.status === 'rejected' || agentsResult.status === 'rejected') {
        const loadMessage = statusResult.status === 'rejected'
          ? describeApiError(statusResult.reason, 'Failed to load MCP onboarding data')
          : describeApiError(
            agentsResult.status === 'rejected' ? agentsResult.reason : null,
            'Failed to load MCP onboarding data'
          );
        setError(loadMessage);
      }
    } catch (loadError: any) {
      setError(describeApiError(loadError, 'Failed to load MCP onboarding data'));
    } finally {
      setLoading(false);
    }
  }, [backendUrl]);

  const loadConfig = useCallback(async (agentId: string) => {
    if (!agentId) return;
    const requestId = ++configRequestIdRef.current;
    setLoadingConfig(true);
    setError(null);
    try {
      const response = await mcpApi.getConfig(agentId, backendUrlRef.current || undefined);
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
  }, [loadConfig, selectedAgent]);

  const persistStartupSelection = useCallback(async (nextSelection: string[]) => {
    setSavingSelection(true);
    try {
      await settingsApi.set(MCP_AUTO_SELECTED_AGENTS_KEY, JSON.stringify(nextSelection));
      setStartupSelectedAgents(nextSelection);
    } catch (persistError: any) {
      setError(describeApiError(persistError, 'Failed to save MCP selection'));
    } finally {
      setSavingSelection(false);
    }
  }, []);

  const toggleStartupAgent = useCallback((agentId: string) => {
    const nextSelection = startupSelectedAgents.includes(agentId)
      ? startupSelectedAgents.filter((id) => id !== agentId)
      : [...startupSelectedAgents, agentId];
    void persistStartupSelection(nextSelection);
  }, [persistStartupSelection, startupSelectedAgents]);

  const handleContinue = useCallback(async () => {
    if (startupSelectedAgents.length === 0) {
      onNext();
      return;
    }

    setSyncingSelection(true);
    setError(null);
    try {
      await settingsApi.set(MCP_AUTO_SELECTED_AGENTS_KEY, JSON.stringify(startupSelectedAgents));
      const response = await mcpApi.syncSetup({
        backendUrl,
        selectedAgentIds: startupSelectedAgents,
        removeUnselected: true,
        buildIfNeeded: true,
      });
      if (response.failures.length > 0) {
        setError(`Atlas connected some tools, but ${response.failures.length} step${response.failures.length === 1 ? '' : 's'} failed. Review Advanced Setup or skip for now.`);
        return;
      }
      onNext();
    } catch (syncError: any) {
      setError(describeApiError(syncError, 'Failed to connect selected MCP tools'));
    } finally {
      setSyncingSelection(false);
    }
  }, [backendUrl, onNext, startupSelectedAgents]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreSetupShortcut(event)) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        onBack();
        return;
      }

      if (!isSetupAdvanceKey(event) || loading || syncingSelection || savingSelection) {
        return;
      }

      event.preventDefault();
      void handleContinue();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleContinue, loading, onBack, savingSelection, syncingSelection]);

  const selectedAgentDetails = agents.find((entry) => entry.id === selectedAgent) || null;
  const quickSetupCommand = `cd mcp-review-server && npm run build && node dist/bin/atlas-review-mcp.js setup --auto --backend-url ${JSON.stringify(backendUrl)}`;
  const selectedAgentCommand = selectedAgentDetails?.recommendedCommands.preferred || quickSetupCommand;
  const workflowGuidance = config?.agent.workflowGuidance || null;

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 mx-auto mb-4" style={{ borderColor: 'var(--accent-blue)', borderTopColor: 'transparent' }} />
        <p style={{ color: 'var(--text-secondary)' }}>Loading MCP setup guidance...</p>
      </div>
    );
  }

  return (
    <div className="text-center">
      <div className="mx-auto mb-6" style={getSetupIconBadgeStyle('blue')}>
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7a4 4 0 118 0v3M6 10h12a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2v-6a2 2 0 012-2z" />
        </svg>
      </div>
      <h2 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>Connect MCP Tools</h2>
      <p className="mb-6 max-w-xl mx-auto" style={{ color: 'var(--text-secondary)' }}>
        Select the tools Atlas should connect now. You can change this later in Settings.
      </p>

      <div className="mb-4 text-left max-w-2xl mx-auto" style={setupInsetPanelStyle}>
        <div className="grid gap-2">
          {selectableAgents.length > 0 ? (
            selectableAgents.map((entry) => {
              const enabled = startupSelectedAgents.includes(entry.id);
              const isToggleDisabled = savingSelection || syncingSelection;

              return (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                  style={getSetupOptionCardStyle({
                    tone: enabled ? 'blue' : 'neutral',
                    selected: enabled,
                  })}
                >
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{entry.displayName}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleStartupAgent(entry.id)}
                    disabled={isToggleDisabled}
                    aria-pressed={enabled}
                    aria-label={`${enabled ? 'Disable' : 'Enable'} ${entry.displayName}`}
                    className={`relative h-6 w-11 rounded-full transition-colors ${isToggleDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                    style={{
                      background: enabled ? 'var(--accent-blue)' : 'var(--review-segment-bg)',
                      border: `1px solid ${enabled ? 'rgba(var(--accent-blue-rgb), 0.38)' : 'var(--review-shell-border)'}`,
                    }}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full transition-all ${enabled ? 'left-[20px]' : 'left-0.5'}`}
                      style={{
                        background: 'var(--review-card-bg)',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
                      }}
                    />
                  </button>
                </div>
              );
            })
          ) : manualOnlyAgents.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Atlas detected {manualOnlyAgents.map((entry) => entry.displayName).join(', ')}, but those clients still use manual setup.
              </p>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                Open manual setup below to copy the config for them.
              </p>
            </div>
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              No supported tools were detected on this machine yet. You can continue and connect Atlas later from Settings.
            </p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => setShowAdvanced((current) => !current)}
            style={getSetupButtonStyle({ tone: 'neutral' })}
          >
            {showAdvanced ? 'Hide manual setup' : 'Show manual setup'}
          </button>
          <button
            onClick={() => void loadOverview()}
            disabled={syncingSelection || savingSelection}
            style={getSetupButtonStyle({ tone: 'neutral', disabled: syncingSelection || savingSelection })}
          >
            <SetupButtonIcon name="refresh" size={14} />
            Refresh
          </button>
        </div>
      </div>

      {showAdvanced && agents.length > 0 && (
        <div className="mb-6 text-left max-w-2xl mx-auto" style={setupInsetPanelStyle}>
          <p className="font-medium mb-3" style={{ color: 'var(--text-primary)' }}>Manual setup</p>

          <div className="mb-3">
            <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Agent</label>
            <select
              value={selectedAgent}
              onChange={(event) => setSelectedAgent(event.target.value)}
              style={setupInputStyle}
            >
              {agents.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.displayName} ({entry.isInstalled ? 'detected' : 'not detected'})
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-2 mb-3">
            <button
              onClick={() => void copyToClipboard(selectedAgentCommand, 'Command')}
              style={getSetupButtonStyle({ tone: 'neutral' })}
            >
              Copy Command
            </button>
            <button
              onClick={() => selectedAgentDetails?.selectedConfigPath && void copyToClipboard(selectedAgentDetails.selectedConfigPath, 'Path')}
              disabled={!selectedAgentDetails?.selectedConfigPath}
              style={getSetupButtonStyle({ tone: 'neutral', disabled: !selectedAgentDetails?.selectedConfigPath })}
            >
              Copy Path
            </button>
            <button
              onClick={() => config?.snippet && void copyToClipboard(config.snippet, 'Snippet')}
              disabled={!config?.snippet || loadingConfig}
              style={getSetupButtonStyle({ tone: 'neutral', disabled: !config?.snippet || loadingConfig })}
            >
              {loadingConfig ? 'Loading...' : 'Copy Snippet'}
            </button>
          </div>

          <div className="space-y-2 text-sm">
            <p className="break-all" style={{ color: 'var(--text-secondary)' }}>{selectedAgentCommand}</p>
              {selectedAgentDetails?.selectedConfigPath && (
                <p className="text-xs break-all" style={{ color: 'var(--text-tertiary)' }}>
                  Config path: {selectedAgentDetails.selectedConfigPath}
                </p>
              )}
              {(selectedAgentDetails?.restartHint || config?.agent.restartHint) && (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  Restart hint: {selectedAgentDetails?.restartHint || config?.agent.restartHint}
                </p>
              )}
          </div>

          {config?.snippet && (
            <pre className="mt-3" style={setupCodeBlockStyle}>
              {config.snippet}
            </pre>
          )}

          {workflowGuidance && (
            <details className="mt-4" style={setupInsetPanelStyle}>
              <summary
                className="cursor-pointer select-none text-sm font-medium"
                style={{ color: 'var(--text-primary)' }}
              >
                {workflowGuidance.title}
              </summary>
              <div className="mt-3">
                <div className="flex flex-wrap gap-2 mb-3">
                  <button
                    onClick={() => void copyToClipboard(workflowGuidance.snippet, workflowGuidance.snippetLabel)}
                    style={getSetupButtonStyle({ tone: 'neutral' })}
                  >
                    Copy {workflowGuidance.snippetLabel}
                  </button>
                </div>
                <div className="space-y-2 text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>
                  {workflowGuidance.installSteps.map((step, index) => (
                    <p key={`${selectedAgent}-workflow-step-${index}`}>{index + 1}. {step}</p>
                  ))}
                  <p>{workflowGuidance.fallbackSummary}</p>
                </div>
                <pre style={setupCodeBlockStyle}>
                  {workflowGuidance.snippet}
                </pre>
              </div>
            </details>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 max-w-2xl mx-auto" style={getSetupNoticeStyle('red')}>
          {error}
        </div>
      )}

      <div className="flex flex-col items-center gap-3">
        <button
          onClick={() => void handleContinue()}
          disabled={syncingSelection || savingSelection}
          style={{
            ...getSetupButtonStyle({ tone: 'blue', active: true, disabled: syncingSelection || savingSelection }),
          }}
        >
          <SetupButtonIcon
            name={startupSelectedAgents.length > 0 ? 'plug' : 'folder'}
            size={16}
          />
          {syncingSelection
            ? 'Connecting selected tools...'
            : startupSelectedAgents.length > 0
              ? 'Connect Selected Tools and Continue'
              : 'Continue to Project Setup'}
        </button>
        <div className="flex gap-4">
          <button
            onClick={onBack}
            style={getSetupButtonStyle({ tone: 'neutral' })}
          >
            Back
          </button>
          <button
            onClick={onSkip}
            style={getSetupTextButtonStyle()}
          >
            Skip MCP setup for now
          </button>
        </div>
      </div>
    </div>
  );
}

export default McpStep;
