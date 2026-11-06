import { useEffect, useRef, useState } from 'react';
import toast from '@/lib/toast';
import {
  agentInstructionApi,
  describeApiError,
  type AgentInstructionFailure,
  type AgentInstructionMutationResult,
  type AgentInstructionPreviewEntry,
  type AgentInstructionTarget,
} from '@/services/api';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface AgentInstructionsModalProps {
  isOpen: boolean;
  projectId: string;
  projectName: string;
  onClose: () => void;
}

type InstructionTargetOption = {
  id: AgentInstructionTarget;
  label: string;
  filePath: string;
  description: string;
};

const TARGET_OPTIONS: InstructionTargetOption[] = [
  { id: 'claude', label: 'Claude Code', filePath: 'CLAUDE.md', description: 'Atlas-managed review guidance inside project memory' },
  { id: 'codex', label: 'Codex', filePath: 'AGENTS.md', description: 'Project rules for Codex sessions' },
  { id: 'cursor', label: 'Cursor', filePath: '.cursorrules', description: 'Cursor workspace rule file' },
  { id: 'copilot', label: 'GitHub Copilot', filePath: '.github/copilot-instructions.md', description: 'Copilot repository instructions' },
  { id: 'vscode', label: 'VS Code', filePath: '.github/copilot-instructions.md', description: 'VS Code instruction file path' },
  { id: 'windsurf', label: 'Windsurf', filePath: '.windsurfrules', description: 'Windsurf rule file' },
];
const PREVIEW_DEBOUNCE_MS = 250;

function AgentInstructionsModal({ isOpen, projectId, projectName, onClose }: AgentInstructionsModalProps) {
  const [selectedTargets, setSelectedTargets] = useState<AgentInstructionTarget[]>(['claude']);
  const [instructionBlock, setInstructionBlock] = useState('');
  const [previews, setPreviews] = useState<AgentInstructionPreviewEntry[]>([]);
  const [results, setResults] = useState<AgentInstructionMutationResult[]>([]);
  const [failures, setFailures] = useState<AgentInstructionFailure[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<'generate' | 'remove' | null>(null);
  const [lastAction, setLastAction] = useState<'generate' | 'remove' | null>(null);
  const previewRequestIdRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setResults([]);
    setFailures([]);
    setLastAction(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setPreviewLoading(false);
      return;
    }
    if (selectedTargets.length === 0) {
      previewRequestIdRef.current += 1;
      setInstructionBlock('');
      setPreviews([]);
      setPreviewLoading(false);
      return;
    }

    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    setPreviewLoading(true);

    const timeoutId = window.setTimeout(() => {
      agentInstructionApi.preview(projectId, selectedTargets)
        .then((response) => {
          if (previewRequestIdRef.current !== requestId) return;
          setInstructionBlock(response.instructionBlock);
          setPreviews(response.previews);
        })
        .catch((error) => {
          if (previewRequestIdRef.current !== requestId) return;
          setInstructionBlock('');
          setPreviews([]);
          toast.error(describeApiError(error, 'Failed to load Atlas agent rule preview'));
        })
        .finally(() => {
          if (previewRequestIdRef.current === requestId) {
            setPreviewLoading(false);
          }
        });
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isOpen, projectId, selectedTargets]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const selectedTargetSet = new Set(selectedTargets);
  const claudeSelected = selectedTargetSet.has('claude');

  const toggleTarget = (target: AgentInstructionTarget) => {
    setResults([]);
    setFailures([]);
    setLastAction(null);
    setSelectedTargets((current) => (
      current.includes(target)
        ? current.filter((entry) => entry !== target)
        : [...current, target]
    ));
  };

  const runMutation = async (action: 'generate' | 'remove') => {
    if (selectedTargets.length === 0 || actionLoading) return;

    try {
      setActionLoading(action);
      setFailures([]);
      const response = action === 'generate'
        ? await agentInstructionApi.generate(projectId, { targets: selectedTargets })
        : await agentInstructionApi.remove(projectId, { targets: selectedTargets });

      if ('instructionBlock' in response && typeof response.instructionBlock === 'string') {
        setInstructionBlock(response.instructionBlock);
      }
      setResults(response.results);
      setFailures(response.failures || []);
      setLastAction(action);

      const changedCount = response.results.filter((result) => result.changed).length;
      const verb = action === 'generate' ? 'Generated' : 'Removed';
      toast.success(`${verb} Atlas rules for ${changedCount}/${response.results.length} target${response.results.length === 1 ? '' : 's'}`);
    } catch (error) {
      toast.error(describeApiError(error, `Failed to ${action === 'generate' ? 'generate' : 'remove'} Atlas agent rules`));
    } finally {
      setActionLoading(null);
    }
  };

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
        background: 'rgba(var(--bg-base-rgb), 0.58)',
        backdropFilter: 'blur(10px)',
        padding: '24px',
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(980px, 100%)',
          maxHeight: 'min(760px, calc(100vh - 48px))',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--review-shell-bg)',
          border: '1px solid var(--review-shell-border-strong)',
          borderRadius: '18px',
          boxShadow: 'var(--review-panel-shadow)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '20px 24px 16px',
            borderBottom: '1px solid var(--review-shell-divider)',
            background: 'var(--review-panel-header-bg)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div className="review-shell-title" style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                Atlas Agent Rules
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
                Generate project-scoped MCP guidance for {projectName}.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                ...getReviewActionButtonStyle({ tone: 'neutral' }),
                width: 32,
                minHeight: 32,
                padding: 0,
                borderRadius: 999,
                cursor: 'pointer',
                fontSize: 16,
              }}
              title="Close"
            >
              ×
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '320px minmax(0, 1fr)',
            gap: 0,
            minHeight: 0,
            flex: 1,
          }}
        >
          <div
            style={{
              borderRight: '1px solid var(--review-shell-divider)',
              padding: 20,
              overflowY: 'auto',
              background: 'var(--review-panel-bg)',
            }}
          >
            <div className="review-shell-muted" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)' }}>
              Targets
            </div>
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {TARGET_OPTIONS.map((option) => {
                const checked = selectedTargetSet.has(option.id);
                return (
                  <label
                    key={option.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 12,
                      padding: '12px 14px',
                      borderRadius: 12,
                      border: checked
                        ? '1px solid var(--review-segment-active-border)'
                        : '1px solid var(--review-shell-border)',
                      background: checked
                        ? 'var(--review-segment-active-bg)'
                        : 'var(--review-card-bg)',
                      boxShadow: checked ? 'inset 0 0 0 1px var(--review-selection-glow)' : 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTarget(option.id)}
                      style={{ marginTop: 3 }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                        {option.label}
                      </div>
                      <div style={{ marginTop: 3, fontSize: 12, color: 'var(--text-secondary)' }}>
                        {option.description}
                      </div>
                      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, monospace)' }}>
                        {option.filePath}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            <div
              style={{
                marginTop: 18,
                padding: '12px 14px',
                borderRadius: 12,
                border: '1px solid var(--chip-warning-border)',
                background: 'var(--chip-warning-bg)',
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--text-secondary-bright)',
              }}
            >
              Atlas writes only a managed sentinel block. Existing project instructions outside that block are preserved.
            </div>
            <div
              style={{
                marginTop: 10,
                padding: '12px 14px',
                borderRadius: 12,
                border: '1px solid var(--chip-info-border)',
                background: 'var(--chip-info-bg)',
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--text-secondary-bright)',
              }}
            >
              Project-scoped Agent Rules are the override path. Use them when this repo needs workflow behavior that differs from the Atlas-managed global default.
            </div>
            {claudeSelected && (
              <div
                style={{
                  marginTop: 10,
                  padding: '12px 14px',
                  borderRadius: 12,
                  border: '1px solid var(--chip-info-border)',
                  background: 'var(--chip-info-bg)',
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: 'var(--text-secondary-bright)',
                }}
              >
                Claude Code uses `CLAUDE.md`. Atlas manages only a protected review-guidance section there and preserves the rest of the memory file, so repo-local `CLAUDE.md` changes stay scoped to this project.
              </div>
            )}
          </div>

          <div style={{ padding: 20, overflowY: 'auto', background: 'var(--review-panel-alt-bg)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div className="review-shell-muted" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)' }}>
                  Preview
                </div>
                <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
                  Atlas review guidance will be inserted into each selected file as a project-level override block.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => runMutation('remove')}
                  disabled={selectedTargets.length === 0 || actionLoading !== null}
                  style={secondaryButtonStyle(selectedTargets.length === 0 || actionLoading !== null)}
                >
                  {actionLoading === 'remove' ? 'Removing…' : 'Remove'}
                </button>
                <button
                  type="button"
                  onClick={() => runMutation('generate')}
                  disabled={selectedTargets.length === 0 || actionLoading !== null}
                  style={primaryButtonStyle(selectedTargets.length === 0 || actionLoading !== null)}
                >
                  {actionLoading === 'generate' ? 'Generating…' : 'Generate'}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {selectedTargets.length === 0 ? (
                <span style={{ fontSize: 13, color: 'var(--text-tertiary, #748094)' }}>
                  Select at least one target to preview Atlas rules.
                </span>
              ) : (
                previews.map((preview) => (
                  <div
                    key={`${preview.target}:${preview.relativeFilePath}`}
                    style={{
                      padding: '7px 10px',
                      borderRadius: 999,
                      border: '1px solid var(--review-shell-border)',
                      background: 'var(--review-card-bg)',
                      fontSize: 12,
                      color: 'var(--text-secondary)',
                    }}
                    title={preview.filePath}
                  >
                    <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{preview.label}</span>
                    {' · '}
                    <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{preview.relativeFilePath}</span>
                  </div>
                ))
              )}
            </div>

            <div
              style={{
                marginTop: 16,
                minHeight: 280,
                borderRadius: 14,
                border: '1px solid var(--review-shell-border)',
                background: 'var(--review-code-bg)',
                overflow: 'hidden',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
              }}
            >
              <div
                style={{
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--review-shell-divider)',
                  fontSize: 12,
                  color: 'var(--text-tertiary)',
                  background: 'var(--review-panel-header-bg)',
                }}
              >
                {previewLoading ? 'Loading preview…' : 'Managed Atlas instruction block'}
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: 16,
                  overflowX: 'auto',
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: 'rgba(var(--text-primary-rgb), 0.92)',
                  fontFamily: 'var(--font-mono, SFMono-Regular, ui-monospace, monospace)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {instructionBlock || 'No preview available.'}
              </pre>
            </div>

            {(results.length > 0 || failures.length > 0) && (
              <div style={{ marginTop: 18 }}>
                <div className="review-shell-muted" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)' }}>
                  {lastAction === 'remove' ? 'Removal Results' : 'Generation Results'}
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {results.map((result) => (
                    <div
                      key={`${lastAction || 'result'}:${result.target}:${result.relativeFilePath}`}
                      style={{
                        padding: '12px 14px',
                        borderRadius: 12,
                        border: '1px solid var(--review-shell-border)',
                        background: 'var(--review-card-bg)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                          {result.label}
                        </div>
                        <div style={{ fontSize: 12, color: result.changed ? 'var(--accent-green)' : 'var(--text-tertiary)' }}>
                          {result.changed
                            ? lastAction === 'remove'
                              ? 'Updated'
                              : result.created
                                ? 'Created'
                                : 'Updated'
                            : 'No change'}
                        </div>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono, monospace)' }}>
                        {result.relativeFilePath}
                      </div>
                      {result.backupPath && (
                        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                          Backup: {result.backupPath}
                        </div>
                      )}
                    </div>
                  ))}
                  {failures.map((failure, index) => (
                    <div
                      key={`failure:${index}`}
                      style={{
                        padding: '12px 14px',
                        borderRadius: 12,
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        background: 'rgba(127, 29, 29, 0.18)',
                        color: '#fecaca',
                        fontSize: 13,
                      }}
                    >
                      {failure.label || failure.target || 'Target'}: {failure.error || failure.message || 'Unknown failure'}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function primaryButtonStyle(disabled: boolean) {
  return {
    ...getReviewActionButtonStyle({ tone: 'blue', active: !disabled, disabled }),
    minHeight: 32,
    padding: '0 14px',
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 700,
  } as const;
}

function secondaryButtonStyle(disabled: boolean) {
  return {
    ...getReviewActionButtonStyle({ tone: 'neutral', disabled }),
    minHeight: 32,
    padding: '0 14px',
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 700,
  } as const;
}

export default AgentInstructionsModal;
