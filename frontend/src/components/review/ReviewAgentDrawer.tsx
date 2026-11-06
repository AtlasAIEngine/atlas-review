import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { emitProjectSocketEvent, emitProjectSocketEventWithAck, subscribeProjectSocket } from '@/services/projectSocket';
import { prReviewApi } from '@/services/api';
import { usePopup } from '@/components/shared/PopupProvider';
import {
  reviewAgentApi,
  type ReviewAgentAction,
  type ReviewAgentActionResult,
  type ReviewAgentAttachment,
  type ReviewAgentScope,
  type ReviewAgentSession,
} from '@/services/reviewAgentApi';
import { PR_REVIEW_CONVERSATIONS_UPDATED_EVENT } from './GitHubConversation';
import {
  getReviewAgentAttachmentLabel,
  getReviewAgentActionKey,
  isSameReviewAgentScope,
  makeReviewAgentLocalMessage,
  type ReviewAgentLocalMessage,
} from './reviewAgentDrawerUtils';

interface ReviewAgentDrawerProps {
  isOpen: boolean;
  width?: number;
  variant?: 'overlay' | 'embedded';
  scope: ReviewAgentScope | null;
  attachments: ReviewAgentAttachment[];
  draftRequest?: { id: string; text: string } | null;
  onRemoveAttachment?: (attachment: ReviewAgentAttachment) => void;
  onMessageSent?: () => void;
  onClose: () => void;
  onFixFindings?: (recommendationKeys: string[]) => boolean | void | { ok: true } | { ok: false; error: string };
  onRunReview?: (mode: 'standard' | 'full') => boolean | void;
  onSetOutcome?: (recommendationKey: string, status: 'addressed' | 'dismissed', note?: string) => boolean | void;
  onPublishPrReview?: (
    action: 'comment' | 'approve' | 'request_changes',
    body?: string,
    recommendationKeys?: string[]
  ) => boolean | void | { ok: true } | { ok: false; error: string };
}

type LocalMessage = ReviewAgentLocalMessage;
type LineRangeAttachment = Extract<ReviewAgentAttachment, { type: 'line_range' }>;
type ReviewAgentToolUse = {
  id?: string | null;
  name: string;
  input?: unknown;
};

const BASE_PROMPT_CHIPS = [
  'Summarize this review',
  'What should I review first?',
  'Which findings block approval?',
  'Any false positives?',
  'What changed since last review?',
  'Show risky files',
  'What looks risky?',
];

function getMessageActions(message: LocalMessage): ReviewAgentAction[] {
  return Array.isArray(message.meta?.actions) ? message.meta.actions : [];
}

function getMessageAttachments(message: LocalMessage): ReviewAgentAttachment[] {
  return Array.isArray(message.meta?.attachments)
    ? message.meta.attachments.filter((attachment): attachment is ReviewAgentAttachment => Boolean(attachment && typeof attachment === 'object'))
    : [];
}

function getMessageToolUses(message: LocalMessage): ReviewAgentToolUse[] {
  return Array.isArray(message.meta?.tools)
    ? message.meta.tools
      .filter((tool): tool is ReviewAgentToolUse => Boolean(tool && typeof tool === 'object' && 'name' in tool))
      .map((tool) => ({
        id: typeof tool.id === 'string' ? tool.id : null,
        name: String(tool.name || 'tool'),
        input: tool.input,
      }))
    : [];
}

function normalizeToolUse(rawTool: unknown): ReviewAgentToolUse {
  const tool = rawTool && typeof rawTool === 'object' ? rawTool as Record<string, unknown> : {};
  return {
    id: typeof tool.id === 'string' ? tool.id : null,
    name: String(tool.name || 'tool'),
    input: tool.input,
  };
}

function pickInitialProgressMessage(prompt: string): string {
  const text = prompt.trim();
  if (!text) return 'Reading review context…';

  const findingMatch = text.match(/\bF(\d+)\b/i);
  if (findingMatch) return `Looking up finding F${findingMatch[1]}…`;

  if (/\b(draft|reply)\b/i.test(text)) return 'Drafting reply…';
  if (/\b(dismiss|mark[^\n]{0,20}addressed)\b/i.test(text)) return 'Preparing outcome action…';
  if (/\b(approve|publish|request[\s-]?changes)\b/i.test(text)) return 'Preparing publish action…';
  if (/\b(rerun|run\s+(the\s+)?review|review\s+again)\b/i.test(text)) return 'Preparing review action…';
  if (/\b(fix|address)\b/i.test(text)) return 'Preparing fix action…';

  const fileMatch = text.match(/\b([\w./-]+\.[a-z]{1,6})\b/i);
  if (fileMatch) {
    const basename = fileMatch[1].split(/[/\\]/).pop() || fileMatch[1];
    return `Checking ${basename}…`;
  }

  return 'Reading review context…';
}

function pickToolUseMessage(tool: ReviewAgentToolUse | null | undefined): string | null {
  if (!tool) return null;
  const input = tool.input && typeof tool.input === 'object' ? tool.input as Record<string, unknown> : {};
  switch (tool.name) {
    case 'Read': {
      const filePath = typeof input.file_path === 'string' ? input.file_path : '';
      if (!filePath) return 'Reading file…';
      const basename = filePath.split(/[/\\]/).pop() || filePath;
      return `Reading ${basename}…`;
    }
    case 'Grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      if (!pattern) return 'Searching the codebase…';
      const display = pattern.length > 40 ? `${pattern.slice(0, 40)}…` : pattern;
      return `Searching for "${display}"…`;
    }
    case 'Glob': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : '';
      if (!pattern) return 'Looking for matching files…';
      const display = pattern.length > 40 ? `${pattern.slice(0, 40)}…` : pattern;
      return `Looking for ${display}…`;
    }
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command : '';
      if (!command) return 'Running command…';
      const display = command.length > 40 ? `${command.slice(0, 40)}…` : command;
      return `Running ${display}…`;
    }
    default:
      return null;
  }
}

function pickTimedProgressMessage(elapsedMs: number): string | null {
  if (elapsedMs >= 12_000) return "Still working—this one's taking a moment…";
  if (elapsedMs >= 7_000) return 'Drafting response…';
  if (elapsedMs >= 3_000) return 'Analyzing findings…';
  return null;
}

function mergeMessageToolUses(existing: ReviewAgentToolUse[], nextTool: ReviewAgentToolUse): ReviewAgentToolUse[] {
  const nextKey = nextTool.id || `${nextTool.name}:${JSON.stringify(nextTool.input ?? null)}`;
  if (existing.some((tool) => (tool.id || `${tool.name}:${JSON.stringify(tool.input ?? null)}`) === nextKey)) {
    return existing;
  }
  return [...existing, nextTool];
}

function findLastStreamingAssistantIndex(messages: LocalMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.isStreaming) {
      return index;
    }
  }
  return -1;
}

function findLastAssistantIndex(messages: LocalMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      return index;
    }
  }
  return -1;
}

function appendToStreamingAssistant(messages: LocalMessage[], text: string, sessionId: string): LocalMessage[] {
  const targetIndex = findLastStreamingAssistantIndex(messages);
  if (targetIndex >= 0) {
    return messages.map((message, index) => (
      index === targetIndex
        ? { ...message, content: message.content + text }
        : message
    ));
  }

  return [
    ...messages,
    makeReviewAgentLocalMessage('assistant', text, { sessionId, isStreaming: true }),
  ];
}

function addToolToStreamingAssistant(messages: LocalMessage[], tool: ReviewAgentToolUse, sessionId: string): LocalMessage[] {
  const targetIndex = findLastStreamingAssistantIndex(messages);
  if (targetIndex >= 0) {
    return messages.map((message, index) => {
      if (index !== targetIndex) return message;
      const tools = mergeMessageToolUses(getMessageToolUses(message), tool);
      return { ...message, meta: { ...(message.meta || {}), tools } };
    });
  }

  return [
    ...messages,
    makeReviewAgentLocalMessage('assistant', '', {
      sessionId,
      isStreaming: true,
      meta: { tools: [tool] },
    }),
  ];
}

function attachActionsToLatestAssistant(messages: LocalMessage[], actions: ReviewAgentAction[]): LocalMessage[] {
  const targetIndex = findLastStreamingAssistantIndex(messages);
  const fallbackIndex = targetIndex >= 0 ? targetIndex : findLastAssistantIndex(messages);
  if (fallbackIndex < 0) return messages;

  return messages.map((message, index) => (
    index === fallbackIndex
      ? { ...message, meta: { ...(message.meta || {}), actions } }
      : message
  ));
}

function completeStreamingAssistant(
  messages: LocalMessage[],
  completedContent: string | null,
  messageId: string | null,
  actions: ReviewAgentAction[]
): LocalMessage[] {
  const streamingIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'assistant' && message.isStreaming)
    .map(({ index }) => index);

  if (streamingIndexes.length === 0) {
    return messages;
  }

  const targetIndex = streamingIndexes[streamingIndexes.length - 1];
  const mergedTools = streamingIndexes.flatMap((index) => getMessageToolUses(messages[index]));

  return messages.flatMap((message, index) => {
    if (!streamingIndexes.includes(index)) {
      return [message];
    }

    if (index !== targetIndex) {
      return [];
    }

    return [{
      ...message,
      ...(messageId ? { id: messageId } : {}),
      isStreaming: false,
      content: completedContent ?? message.content,
      meta: {
        ...(message.meta || {}),
        ...(mergedTools.length > 0 ? { tools: mergedTools } : {}),
        ...(actions.length > 0 ? { actions } : {}),
      },
    }];
  });
}

function getSelectedCodeAttachments(attachments: ReviewAgentAttachment[]): LineRangeAttachment[] {
  return attachments.filter((attachment): attachment is LineRangeAttachment => (
    attachment.type === 'line_range' && Boolean(String(attachment.selectedText || '').trim())
  ));
}

function getAttachedFindingId(attachments: ReviewAgentAttachment[]): string | null {
  const finding = attachments.find((attachment) => attachment.type === 'finding');
  if (!finding || finding.type !== 'finding') return null;
  const findingId = String(finding.findingId || '').trim().toUpperCase();
  return /^F[1-9]\d*$/.test(findingId) ? findingId : null;
}

function isRawReviewAgentActionContent(content: string): boolean {
  const trimmed = String(content || '').trim();
  if (!trimmed) return false;
  const withoutFence = trimmed
    .replace(/^```[^\n`]*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  const normalized = withoutFence.includes('\\"') ? withoutFence.replace(/\\"/g, '"') : withoutFence;
  return /^[{\[][\s\S]*"type"\s*:\s*"(fix_findings|draft_pr_reply|run_review|set_outcome|publish_pr_review)"/.test(normalized);
}

function shouldShowReviewAgentMessage(message: LocalMessage): boolean {
  if (message.role !== 'assistant') return true;
  if (getMessageActions(message).length > 0) return true;
  return !isRawReviewAgentActionContent(message.content);
}

type RecordActionResult = (actionKey: string, result: ReviewAgentActionResult) => void;

function getPersistedResultLabel(result: ReviewAgentActionResult | null | undefined): string | null {
  if (!result || result.status === 'failed') return null;
  return result.label || null;
}

function buildActionResult(status: ReviewAgentActionResult['status'], label: string, detail?: string): ReviewAgentActionResult {
  return {
    status,
    label,
    ...(detail ? { detail } : {}),
    at: new Date().toISOString(),
  };
}

function formatReviewAgentTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function TypingDots({ message }: { message?: string | null } = {}) {
  return (
    <div
      aria-label={message ? `Review assistant: ${message}` : 'Review assistant is working'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: message ? 8 : 5,
        padding: '10px 14px',
        borderRadius: 10,
        background: 'var(--bg-surface-raised)',
        border: '1px solid var(--review-shell-border)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: 'var(--text-secondary)',
              opacity: 0.72,
              animation: 'review-agent-dot-pulse 1.1s ease-in-out infinite',
              animationDelay: `${index * 140}ms`,
            }}
          />
        ))}
      </span>
      {message && (
        <span style={{
          fontSize: 12,
          lineHeight: 1.4,
          color: 'var(--text-secondary)',
          maxWidth: 320,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {message}
        </span>
      )}
    </div>
  );
}

function ToolUseDisclosure({ tools }: { tools: ReviewAgentToolUse[] }) {
  if (tools.length === 0) return null;

  return (
    <details
      style={{
        marginTop: 9,
        border: '1px solid rgba(var(--accent-blue-rgb), 0.18)',
        borderRadius: 7,
        background: 'rgba(var(--accent-blue-rgb), 0.06)',
        overflow: 'hidden',
      }}
    >
      <summary
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '7px 9px',
          cursor: 'pointer',
          color: 'var(--text-secondary)',
          fontSize: 11,
          fontWeight: 650,
          userSelect: 'none',
        }}
      >
        <span style={{ color: 'var(--accent-blue)' }}>›</span>
        <span>Tool calls</span>
        <span style={{ color: 'var(--text-tertiary)', fontWeight: 600 }}>{tools.length}</span>
      </summary>
      <div style={{
        display: 'grid',
        gap: 7,
        padding: '0 9px 9px',
      }}>
        {tools.map((tool, index) => {
          const inputText = tool.input == null
            ? ''
            : typeof tool.input === 'string'
              ? tool.input
              : JSON.stringify(tool.input, null, 2);
          return (
            <div
              key={`${tool.id || tool.name}-${index}`}
              style={{
                borderTop: index === 0 ? '1px solid rgba(var(--accent-blue-rgb), 0.14)' : 'none',
                paddingTop: index === 0 ? 8 : 0,
                display: 'grid',
                gap: 5,
                minWidth: 0,
              }}
            >
              <div style={{
                color: 'var(--text-primary)',
                fontSize: 11,
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {tool.name}
              </div>
              {inputText && (
                <pre style={{
                  margin: 0,
                  maxHeight: 140,
                  overflow: 'auto',
                  padding: 8,
                  borderRadius: 6,
                  border: '1px solid var(--review-shell-border)',
                  background: 'var(--review-code-bg)',
                  color: 'var(--text-tertiary)',
                  fontSize: 10.5,
                  lineHeight: 1.4,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}>
                  {inputText}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function DraftPrReplyActionCard({
  action,
  scope,
  actionKey,
  actionResult,
  onRecordActionResult,
}: {
  action: Extract<ReviewAgentAction, { type: 'draft_pr_reply' }>;
  scope: ReviewAgentScope | null;
  actionKey: string;
  actionResult?: ReviewAgentActionResult;
  onRecordActionResult?: RecordActionResult;
}) {
  const [draft, setDraft] = useState(action.body);
  const [isSending, setIsSending] = useState(false);
  const [status, setStatus] = useState<string | null>(() => getPersistedResultLabel(actionResult));
  const [error, setError] = useState<string | null>(null);
  const normalizedDraft = draft.trim();

  useEffect(() => {
    setDraft(action.body);
    setStatus(getPersistedResultLabel(actionResult));
    setError(null);
  }, [action.body, action.threadNodeId, actionResult]);

  const send = async () => {
    if (!scope || scope.reviewType !== 'pr_review' || !normalizedDraft || isSending) return;
    setIsSending(true);
    setStatus(null);
    setError(null);
    try {
      const response = await prReviewApi.replyToConversationThread(
        scope.projectId,
        scope.reviewId,
        action.threadNodeId,
        normalizedDraft
      );
      window.dispatchEvent(new CustomEvent(PR_REVIEW_CONVERSATIONS_UPDATED_EVENT, {
        detail: {
          projectId: scope.projectId,
          prReviewId: scope.reviewId,
          conversations: response.conversations,
        },
      }));
      const result = buildActionResult('posted', 'Reply posted to GitHub', action.threadNodeId);
      setStatus(result.label);
      onRecordActionResult?.(actionKey, result);
    } catch (err: any) {
      const message = err?.response?.data?.error || err?.message || 'Failed to post GitHub reply';
      setError(message);
      onRecordActionResult?.(actionKey, buildActionResult('failed', 'Failed to post GitHub reply', message));
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div style={{
      marginTop: 8,
      border: '1px solid var(--chip-info-border)',
      background: 'var(--chip-info-bg)',
      borderRadius: 6,
      padding: 10,
      display: 'grid',
      gap: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
          Draft PR reply
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {action.threadNodeId.slice(0, 18)}
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={5}
        disabled={isSending || Boolean(status)}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          resize: 'vertical',
          minHeight: 96,
          maxHeight: 220,
          border: '1px solid var(--border-primary)',
          borderRadius: 4,
          padding: 8,
          background: 'var(--bg-input)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-sans)',
          fontSize: 11.5,
          lineHeight: 1.45,
          outline: 'none',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
        {error && <span style={{ flex: 1, color: 'var(--accent-red)', fontSize: 10.5 }}>{error}</span>}
        {status && <span style={{ flex: 1, color: 'var(--sev-ok)', fontSize: 10.5 }}>{status}</span>}
        <button
          type="button"
          onClick={() => {
            void send();
          }}
          disabled={scope?.reviewType !== 'pr_review' || !normalizedDraft || isSending || Boolean(status)}
          style={{
            border: '1px solid var(--accent-blue)',
            background: 'transparent',
            color: scope?.reviewType === 'pr_review' && normalizedDraft && !isSending && !status ? 'var(--accent-blue)' : 'var(--text-tertiary)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
            fontWeight: 600,
            cursor: scope?.reviewType === 'pr_review' && normalizedDraft && !isSending && !status ? 'pointer' : 'default',
          }}
        >
          {isSending ? 'Posting...' : 'Post reply'}
        </button>
      </div>
    </div>
  );
}

function FixFindingsActionCard({
  action,
  onFixFindings,
  actionKey,
  actionResult,
  onRecordActionResult,
}: {
  action: Extract<ReviewAgentAction, { type: 'fix_findings' }>;
  onFixFindings?: (recommendationKeys: string[]) => boolean | void | { ok: true } | { ok: false; error: string };
  actionKey: string;
  actionResult?: ReviewAgentActionResult;
  onRecordActionResult?: RecordActionResult;
}) {
  const [status, setStatus] = useState<string | null>(() => getPersistedResultLabel(actionResult));
  const [error, setError] = useState<string | null>(null);
  const recommendationKeys = Array.isArray(action.recommendationKeys)
    ? action.recommendationKeys.filter(Boolean)
    : [];
  const canOpen = recommendationKeys.length > 0 && Boolean(onFixFindings) && !status;

  useEffect(() => {
    setStatus(getPersistedResultLabel(actionResult));
    setError(null);
  }, [actionResult]);

  const runFixIssues = () => {
    if (!canOpen) return;
    const outcome = onFixFindings?.(recommendationKeys);
    if (outcome === false || (outcome && typeof outcome === 'object' && !outcome.ok)) {
      const message = typeof outcome === 'object' && outcome && 'error' in outcome
        ? outcome.error
        : 'Unable to start Fix Issues.';
      setError(message);
      onRecordActionResult?.(actionKey, buildActionResult('failed', 'Fix Issues not started', message));
      return;
    }
    const result = buildActionResult('opened', 'Fix Issues started', recommendationKeys.join(','));
    setStatus(result.label);
    setError(null);
    onRecordActionResult?.(actionKey, result);
  };

  return (
    <div style={{
      marginTop: 8,
      maxWidth: '100%',
      minWidth: 0,
      boxSizing: 'border-box',
      border: '1px solid var(--border-primary)',
      background: 'var(--bg-surface-raised)',
      borderRadius: 6,
      padding: 10,
      display: 'grid',
      gap: 8,
      overflowWrap: 'anywhere',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 8,
        flexWrap: 'wrap',
        minWidth: 0,
      }}>
        <div style={{ minWidth: 0, flex: '1 1 180px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
            Fix Issues
          </div>
          {status && <div style={{ marginTop: 3, color: 'var(--sev-ok)', fontSize: 10.5 }}>{status}</div>}
          {error && <div style={{ marginTop: 3, color: 'var(--accent-red)', fontSize: 10.5 }}>{error}</div>}
        </div>
        <button
          type="button"
          disabled={!canOpen}
          onClick={runFixIssues}
          style={{
            border: '1px solid var(--accent-blue)',
            background: canOpen ? 'var(--accent-blue)' : 'transparent',
            color: canOpen ? 'var(--bg-base)' : 'var(--text-tertiary)',
            borderRadius: 5,
            padding: '5px 9px',
            fontSize: 11,
            fontWeight: 700,
            cursor: canOpen ? 'pointer' : 'default',
            whiteSpace: 'nowrap',
            flex: '0 0 auto',
          }}
        >
          Run fix
        </button>
      </div>
      <div style={{
        minWidth: 0,
        maxWidth: '100%',
        fontSize: 10.5,
        color: 'var(--text-secondary)',
        lineHeight: 1.45,
        overflowWrap: 'anywhere',
      }}>
        Confirm to run the existing Atlas Fix Issues flow for {recommendationKeys.length} selected finding{recommendationKeys.length === 1 ? '' : 's'}. Status appears in the review panel.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' }}>
        {recommendationKeys.map((key) => (
          <span
            key={key}
            style={{
              maxWidth: '100%',
              minWidth: 0,
              width: '100%',
              boxSizing: 'border-box',
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              border: '1px solid var(--border-primary)',
              borderRadius: 4,
              padding: '2px 6px',
              color: 'var(--text-tertiary)',
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
            }}
            title={key}
          >
            {key}
          </span>
        ))}
      </div>
    </div>
  );
}

function RunReviewActionCard({
  action,
  onRunReview,
  actionKey,
  actionResult,
  onRecordActionResult,
}: {
  action: Extract<ReviewAgentAction, { type: 'run_review' }>;
  onRunReview?: (mode: 'standard' | 'full') => boolean | void;
  actionKey: string;
  actionResult?: ReviewAgentActionResult;
  onRecordActionResult?: RecordActionResult;
}) {
  const [status, setStatus] = useState<string | null>(() => getPersistedResultLabel(actionResult));
  const mode = action.mode === 'full' ? 'full' : 'standard';
  const canRun = Boolean(onRunReview) && !status;

  useEffect(() => {
    setStatus(getPersistedResultLabel(actionResult));
  }, [actionResult]);

  return (
    <div style={{
      marginTop: 8,
      border: '1px solid var(--border-primary)',
      background: 'var(--bg-surface-raised)',
      borderRadius: 6,
      padding: 10,
      display: 'grid',
      gap: 8,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
        Run review
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        Starts the existing Atlas {mode === 'full' ? 'full review' : 'review'} flow for this review scope.
      </div>
      {status && <div style={{ color: 'var(--sev-ok)', fontSize: 10.5 }}>{status}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          disabled={!canRun}
          onClick={() => {
            const opened = onRunReview?.(mode);
            if (opened !== false) {
              const result = buildActionResult('opened', mode === 'full' ? 'Full review started' : 'Review started', mode);
              setStatus(result.label);
              onRecordActionResult?.(actionKey, result);
            }
          }}
          style={{
            border: '1px solid var(--accent-blue)',
            background: 'transparent',
            color: canRun ? 'var(--accent-blue)' : 'var(--text-tertiary)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
            fontWeight: 600,
            cursor: canRun ? 'pointer' : 'default',
          }}
        >
          {mode === 'full' ? 'Start full review' : 'Start review'}
        </button>
      </div>
    </div>
  );
}

function SetOutcomeActionCard({
  action,
  onSetOutcome,
  actionKey,
  actionResult,
  onRecordActionResult,
}: {
  action: Extract<ReviewAgentAction, { type: 'set_outcome' }>;
  onSetOutcome?: (recommendationKey: string, status: 'addressed' | 'dismissed', note?: string) => boolean | void;
  actionKey: string;
  actionResult?: ReviewAgentActionResult;
  onRecordActionResult?: RecordActionResult;
}) {
  const [status, setStatus] = useState<string | null>(() => getPersistedResultLabel(actionResult));
  const [error, setError] = useState<string | null>(null);
  const actionLabel = action.status === 'addressed' ? 'Mark addressed' : 'Mark dismissed';
  const canApply = Boolean(action.recommendationKey && onSetOutcome && !status);

  useEffect(() => {
    setStatus(getPersistedResultLabel(actionResult));
  }, [actionResult]);

  return (
    <div style={{
      marginTop: 8,
      border: '1px solid var(--border-primary)',
      background: 'var(--bg-surface-raised)',
      borderRadius: 6,
      padding: 10,
      display: 'grid',
      gap: 8,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
        Finding outcome
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        Persists a local Atlas outcome for the attached finding. Use this only after verification.
      </div>
      <span style={{
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        border: '1px solid var(--border-primary)',
        borderRadius: 4,
        padding: '2px 6px',
        color: 'var(--text-tertiary)',
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
      }} title={action.recommendationKey}>
        {action.recommendationKey}
      </span>
      {action.note && (
        <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          {action.note}
        </div>
      )}
      {error && <div style={{ color: 'var(--accent-red)', fontSize: 10.5 }}>{error}</div>}
      {status && <div style={{ color: 'var(--sev-ok)', fontSize: 10.5 }}>{status}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          disabled={!canApply}
          onClick={() => {
            setError(null);
            const confirmed = window.confirm(`${actionLabel} in Atlas? Do this only after you have verified the finding state.`);
            if (!confirmed) return;
            const applied = onSetOutcome?.(action.recommendationKey, action.status, action.note);
            if (applied === false) {
              setError('Atlas could not apply this outcome for the current review.');
              onRecordActionResult?.(actionKey, buildActionResult('failed', 'Failed to apply outcome', action.recommendationKey));
              return;
            }
            const result = buildActionResult('applied', action.status === 'addressed' ? 'Marked addressed' : 'Marked dismissed', action.recommendationKey);
            setStatus(result.label);
            onRecordActionResult?.(actionKey, result);
          }}
          style={{
            border: '1px solid var(--accent-blue)',
            background: 'transparent',
            color: canApply ? 'var(--accent-blue)' : 'var(--text-tertiary)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
            fontWeight: 600,
            cursor: canApply ? 'pointer' : 'default',
          }}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

function PublishPrReviewActionCard({
  action,
  scope,
  onPublishPrReview,
  actionKey,
  actionResult,
  onRecordActionResult,
}: {
  action: Extract<ReviewAgentAction, { type: 'publish_pr_review' }>;
  scope: ReviewAgentScope | null;
  onPublishPrReview?: (
    action: 'comment' | 'approve' | 'request_changes',
    body?: string,
    recommendationKeys?: string[]
  ) => boolean | void | { ok: true } | { ok: false; error: string };
  actionKey: string;
  actionResult?: ReviewAgentActionResult;
  onRecordActionResult?: RecordActionResult;
}) {
  const [status, setStatus] = useState<string | null>(() => getPersistedResultLabel(actionResult));
  const [error, setError] = useState<string | null>(null);
  const label = action.action === 'request_changes'
    ? 'Request changes'
    : action.action === 'approve'
      ? 'Approve PR'
      : 'Open publish flow';
  const recommendationKeys = Array.isArray(action.recommendationKeys)
    ? action.recommendationKeys.filter(Boolean)
    : [];
  const canOpen = scope?.reviewType === 'pr_review' && Boolean(onPublishPrReview) && !status;

  useEffect(() => {
    setStatus(getPersistedResultLabel(actionResult));
  }, [actionResult]);

  return (
    <div style={{
      marginTop: 8,
      border: '1px solid var(--chip-info-border)',
      background: 'var(--chip-info-bg)',
      borderRadius: 6,
      padding: 10,
      display: 'grid',
      gap: 8,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
        PR review publish
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        Opens the existing Atlas PR publish flow. Nothing is posted to GitHub until you confirm there.
      </div>
      {action.body && (
        <div style={{
          border: '1px solid var(--border-primary)',
          borderRadius: 4,
          padding: 8,
          background: 'var(--bg-input)',
          color: 'var(--text-secondary)',
          fontSize: 10.5,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          maxHeight: 120,
          overflow: 'auto',
        }}>
          {action.body}
        </div>
      )}
      {recommendationKeys.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {recommendationKeys.map((key) => (
            <span
              key={key}
              style={{
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                border: '1px solid var(--border-primary)',
                borderRadius: 4,
                padding: '2px 6px',
                color: 'var(--text-tertiary)',
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
              }}
              title={key}
            >
              {key}
            </span>
          ))}
        </div>
      )}
      {error && <div style={{ color: 'var(--accent-red)', fontSize: 10.5 }}>{error}</div>}
      {status && <div style={{ color: 'var(--sev-ok)', fontSize: 10.5 }}>{status}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          disabled={!canOpen}
          onClick={() => {
            setError(null);
            const result = onPublishPrReview?.(action.action, action.body, recommendationKeys);
            if (result === false || (typeof result === 'object' && result && result.ok === false)) {
              const detail = typeof result === 'object' && result && result.ok === false ? result.error : 'Atlas could not open the PR publish flow.';
              setError(detail);
              onRecordActionResult?.(actionKey, buildActionResult('failed', 'Failed to open publish flow', detail));
              return;
            }
            const nextResult = buildActionResult('opened', action.action === 'approve' ? 'Approval dialog opened' : 'Publish dialog opened', action.action);
            setStatus(nextResult.label);
            onRecordActionResult?.(actionKey, nextResult);
          }}
          style={{
            border: '1px solid var(--accent-blue)',
            background: 'transparent',
            color: canOpen ? 'var(--accent-blue)' : 'var(--text-tertiary)',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
            fontWeight: 600,
            cursor: canOpen ? 'pointer' : 'default',
          }}
        >
          {label}
        </button>
      </div>
    </div>
  );
}

export function ReviewAgentDrawer({
  isOpen,
  width = 520,
  variant = 'overlay',
  scope,
  attachments,
  draftRequest,
  onRemoveAttachment,
  onMessageSent,
  onClose,
  onFixFindings,
  onRunReview,
  onSetOutcome,
  onPublishPrReview,
}: ReviewAgentDrawerProps) {
  const popup = usePopup();
  const [session, setSession] = useState<ReviewAgentSession | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codePreview, setCodePreview] = useState<LineRangeAttachment | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scopeRef = useRef<ReviewAgentScope | null>(null);
  const appliedDraftRequestRef = useRef<string | null>(null);
  const progressStartedAtRef = useRef<number | null>(null);
  const progressToolMessageRef = useRef<string | null>(null);

  const normalizedAttachments = useMemo(() => attachments.slice(0, 8), [attachments]);
  const selectedCodeAttachments = useMemo(() => getSelectedCodeAttachments(normalizedAttachments), [normalizedAttachments]);
  const promptChips = useMemo(() => {
    const attachedFindingId = getAttachedFindingId(normalizedAttachments);
    const hasFindingAttachment = normalizedAttachments.some((attachment) => attachment.type === 'finding');
    const hasGitHubThreadAttachment = normalizedAttachments.some((attachment) => attachment.type === 'github_thread');
    return [
      ...BASE_PROMPT_CHIPS.slice(0, 2),
      attachedFindingId ? `Explain ${attachedFindingId}` : 'Explain F1',
      attachedFindingId ? `Fix ${attachedFindingId}` : 'Fix F1',
      ...BASE_PROMPT_CHIPS.slice(2),
      ...(hasFindingAttachment && !attachedFindingId ? ['Explain this finding', 'Fix this finding'] : []),
      ...(hasGitHubThreadAttachment ? ['Draft PR reply'] : []),
      ...(scope ? ['Run review'] : []),
    ];
  }, [normalizedAttachments, scope]);

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  useEffect(() => {
    if (!isOpen || !draftRequest?.id) return;
    if (appliedDraftRequestRef.current === draftRequest.id) return;
    appliedDraftRequestRef.current = draftRequest.id;
    setDraft(draftRequest.text || '');
  }, [draftRequest?.id, draftRequest?.text, isOpen]);

  useEffect(() => {
    if (!isOpen || !scope || !session || isStreaming) return;
    const timeoutId = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input || input.disabled) return;
      input.focus();
      const caretPosition = input.value.length;
      input.setSelectionRange(caretPosition, caretPosition);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [draftRequest?.id, isOpen, isStreaming, scope?.projectId, scope?.reviewType, scope?.reviewId, session?.id]);

  useEffect(() => {
    if (!isOpen || !scope) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    reviewAgentApi.createSession(scope)
      .then(async ({ session: createdSession }) => {
        if (cancelled) return;
        setSession(createdSession);
        const history = await reviewAgentApi.getMessages(scope, createdSession.id);
        if (cancelled) return;
        setMessages(history.messages.filter(shouldShowReviewAgentMessage));
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || 'Failed to load review assistant');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, scope?.projectId, scope?.reviewType, scope?.reviewId]);

  useEffect(() => {
    if (!isOpen || !scope?.projectId || !session?.id) return;
    return subscribeProjectSocket(scope.projectId, {
      'review-agent-stream': (payload) => {
        if (!isSameReviewAgentScope(scopeRef.current, payload) || payload?.sessionId !== session.id) return;
        const text = String(payload?.text || '');
        if (!text) return;
        setIsStreaming(true);
        setProgressMessage(null);
        progressToolMessageRef.current = null;
        setMessages((prev) => appendToStreamingAssistant(prev, text, session.id));
      },
      'review-agent-tool-use': (payload) => {
        if (!isSameReviewAgentScope(scopeRef.current, payload) || payload?.sessionId !== session.id) return;
        setIsStreaming(true);
        const normalized = normalizeToolUse(payload?.tool);
        const toolMessage = pickToolUseMessage(normalized);
        // Always update the ref — including when the new tool has no message.
        // Without this, an unknown tool after a known one leaves the ref stuck
        // pointing at the previous tool's message, permanently blocking the
        // timed progression loop (which guards on this ref being null).
        progressToolMessageRef.current = toolMessage;
        if (toolMessage) {
          setProgressMessage(toolMessage);
        }
        setMessages((prev) => addToolToStreamingAssistant(prev, normalized, session.id));
      },
      'review-agent-action': (payload) => {
        if (!isSameReviewAgentScope(scopeRef.current, payload) || payload?.sessionId !== session.id) return;
        const actions = Array.isArray(payload?.actions) ? payload.actions : [];
        if (actions.length === 0) return;
        setMessages((prev) => attachActionsToLatestAssistant(prev, actions));
      },
      'review-agent-complete': (payload) => {
        if (!isSameReviewAgentScope(scopeRef.current, payload) || payload?.sessionId !== session.id) return;
        setIsStreaming(false);
        setProgressMessage(null);
        progressStartedAtRef.current = null;
        progressToolMessageRef.current = null;
        const actions = Array.isArray(payload?.actions) ? payload.actions : [];
        const completedContent = typeof payload?.content === 'string' ? payload.content : null;
        const messageId = typeof payload?.messageId === 'string' && payload.messageId.trim() ? payload.messageId.trim() : null;
        setMessages((prev) => completeStreamingAssistant(prev, completedContent, messageId, actions));
      },
      'review-agent-error': (payload) => {
        if (!isSameReviewAgentScope(scopeRef.current, payload) || payload?.sessionId !== session.id) return;
        setIsStreaming(false);
        setProgressMessage(null);
        progressStartedAtRef.current = null;
        progressToolMessageRef.current = null;
        setError(String(payload?.error || 'Review assistant failed'));
      },
    });
  }, [isOpen, scope?.projectId, scope?.reviewType, scope?.reviewId, session?.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.content]);

  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !scope || !session || isStreaming) return;
    setError(null);
    setDraft('');
    setIsStreaming(true);
    progressStartedAtRef.current = Date.now();
    progressToolMessageRef.current = null;
    setProgressMessage(pickInitialProgressMessage(trimmed));
    setMessages((prev) => [
      ...prev,
      makeReviewAgentLocalMessage('user', trimmed, {
        sessionId: session.id,
        meta: normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : null,
      }),
    ]);
    emitProjectSocketEvent(scope.projectId, 'review-agent-message', {
      ...scope,
      sessionId: session.id,
      message: trimmed,
      attachments: normalizedAttachments,
    });
    onMessageSent?.();
  }, [scope, session, isStreaming, normalizedAttachments, onMessageSent]);

  const stop = useCallback(() => {
    if (!scope || !session) return;
    void emitProjectSocketEventWithAck(scope.projectId, 'review-agent-stop', {
      ...scope,
      sessionId: session.id,
    }).catch(() => {});
    setIsStreaming(false);
    setProgressMessage(null);
    progressStartedAtRef.current = null;
    progressToolMessageRef.current = null;
  }, [scope, session]);

  // Advance the time-based progress message while we're waiting for the first
  // streamed token. Tool-use events (handled above) take precedence over the
  // timed sequence; once tool message is set we keep it until the next event.
  useEffect(() => {
    if (!isStreaming) return;
    const interval = window.setInterval(() => {
      const startedAt = progressStartedAtRef.current;
      if (!startedAt) return;
      // Don't override an active tool-use message with a generic timed one.
      if (progressToolMessageRef.current) return;
      const next = pickTimedProgressMessage(Date.now() - startedAt);
      if (next) {
        setProgressMessage((current) => (current === next ? current : next));
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [isStreaming]);

  const clearableMessageCount = useMemo(() => (
    messages.filter((message) => message.role === 'user' || message.role === 'assistant').length
  ), [messages]);

  const handleClearChat = useCallback(async () => {
    if (!scope || !session || isStreaming || isLoading || isClearing || clearableMessageCount === 0) return;
    const confirmed = await popup.confirm({
      title: 'Delete Review Chat History',
      message: [
        'Delete chat history for this review?',
        `${clearableMessageCount} message${clearableMessageCount === 1 ? '' : 's'} will be removed from this review assistant.`,
        'This resets the assistant context for this review and cannot be undone.',
      ].join('\n'),
      confirmLabel: 'Delete history',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;

    setIsClearing(true);
    setError(null);
    try {
      await reviewAgentApi.deleteSession(scope, session.id);
      const { session: freshSession } = await reviewAgentApi.createSession(scope);
      setSession(freshSession);
      setDraft('');
      setMessages([
        makeReviewAgentLocalMessage('system', 'Review chat history cleared. You can start a fresh request.', {
          sessionId: freshSession.id,
        }),
      ]);
    } catch (err: any) {
      setError(err?.message || 'Failed to clear review chat history');
    } finally {
      setIsClearing(false);
    }
  }, [clearableMessageCount, isClearing, isLoading, isStreaming, popup, scope, session]);

  const renderSelectedCodeAttachments = useCallback((attachmentList: ReviewAgentAttachment[], compact = false) => {
    const codeAttachments = getSelectedCodeAttachments(attachmentList);
    if (codeAttachments.length === 0) return null;
    return (
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: compact ? 9 : 10,
      }}>
        {codeAttachments.map((attachment, index) => {
          const selectedText = String(attachment.selectedText || '').trim();
          const previewLines = selectedText.split('\n').slice(0, compact ? 2 : 4);
          return (
            <button
              key={`${attachment.path}-${attachment.startLine}-${attachment.endLine}-${index}`}
              type="button"
              onClick={() => setCodePreview(attachment)}
              title="Open selected code"
              style={{
                position: 'relative',
                width: compact ? 'min(100%, 260px)' : 'min(100%, 320px)',
                minWidth: 0,
                padding: 0,
                border: '1px solid rgba(var(--accent-blue-rgb), 0.24)',
                borderRadius: 9,
                background: 'rgba(12, 19, 31, 0.92)',
                color: 'var(--text-primary)',
                overflow: 'hidden',
                cursor: 'pointer',
                textAlign: 'left',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
              }}
            >
              {!compact && onRemoveAttachment && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label="Remove selected code attachment"
                  title="Remove attachment"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onRemoveAttachment(attachment);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    onRemoveAttachment(attachment);
                  }}
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    zIndex: 1,
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(4, 8, 14, 0.78)',
                    color: 'var(--text-secondary)',
                    fontSize: 15,
                    lineHeight: 1,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </span>
              )}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minWidth: 0,
                padding: '8px 9px',
                borderBottom: '1px solid rgba(var(--accent-blue-rgb), 0.14)',
                background: 'rgba(var(--accent-blue-rgb), 0.08)',
              }}>
                <span style={{
                  width: 30,
                  height: 24,
                  borderRadius: 6,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  border: '1px solid rgba(var(--accent-blue-rgb), 0.26)',
                  background: 'rgba(var(--accent-blue-rgb), 0.12)',
                  color: 'var(--accent-blue)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  fontWeight: 800,
                }}>
                  CODE
                </span>
                <span style={{ minWidth: 0, display: 'grid', gap: 2 }}>
                  <span style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 11.5,
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                  }}>
                    {attachment.path}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                    Lines {attachment.startLine}-{attachment.endLine}{attachment.side ? ` · ${attachment.side}` : ''}
                  </span>
                </span>
              </div>
              <pre style={{
                margin: 0,
                padding: '8px 9px',
                maxHeight: compact ? 48 : 86,
                overflow: 'hidden',
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                lineHeight: 1.45,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}>
                {previewLines.join('\n')}{selectedText.split('\n').length > previewLines.length ? '\n...' : ''}
              </pre>
            </button>
          );
        })}
      </div>
    );
  }, [onRemoveAttachment]);

  const recordActionResult = useCallback((messageId: string, actionKey: string, result: ReviewAgentActionResult) => {
    if (!scope || !session || !messageId || !actionKey) return;
    setMessages((prev) => prev.map((message) => {
      if (message.id !== messageId) return message;
      const meta = message.meta || {};
      return {
        ...message,
        meta: {
          ...meta,
          actionResults: {
            ...(meta.actionResults || {}),
            [actionKey]: result,
          },
        },
      };
    }));
    void reviewAgentApi.recordActionResult(scope, session.id, messageId, actionKey, result)
      .then(({ message }) => {
        setMessages((prev) => prev.map((entry) => (entry.id === message.id ? { ...entry, meta: message.meta } : entry)));
      })
      .catch((err) => {
        console.warn('Failed to persist review assistant action result:', err);
      });
  }, [scope, session]);

  const canSend = Boolean(draft.trim() && scope && session && !isStreaming);
  const latestMessage = messages[messages.length - 1];
  const showTypingIndicator = isStreaming && !(latestMessage?.role === 'assistant' && latestMessage.content.trim());
  const statusText = isClearing ? 'Clearing' : isLoading ? 'Loading' : scope && session ? 'Connected' : 'Connecting';
  const canClearChat = Boolean(scope && session && clearableMessageCount > 0 && !isLoading && !isStreaming && !isClearing);

  if (!isOpen) return null;

  return (
    <div
      data-testid="review-agent-drawer"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      style={{
        position: variant === 'embedded' ? 'relative' : 'fixed',
        inset: variant === 'embedded' ? undefined : '0 0 0 auto',
        width: variant === 'embedded' ? width : 'min(520px, 100vw)',
        minWidth: variant === 'embedded' ? 0 : undefined,
        height: variant === 'embedded' ? '100%' : undefined,
        zIndex: variant === 'embedded' ? 'auto' : 80,
        background: 'linear-gradient(180deg, rgba(14, 20, 32, 0.96) 0%, var(--review-panel-bg) 42%, var(--review-panel-bg) 100%)',
        borderLeft: '1px solid var(--review-shell-border)',
        boxShadow: variant === 'embedded' ? 'none' : '-18px 0 42px rgba(0,0,0,0.34)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <style>
        {`
          @keyframes review-agent-dot-pulse {
            0%, 80%, 100% { transform: translateY(0); opacity: 0.38; }
            40% { transform: translateY(-3px); opacity: 0.92; }
          }
        `}
      </style>
      <div style={{
        minHeight: 58,
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderBottom: '1px solid var(--review-shell-border)',
        background: 'var(--review-panel-header-bg)',
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            marginBottom: 5,
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
          }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 9px',
              borderRadius: 999,
              background: 'rgba(var(--accent-blue-rgb), 0.13)',
              border: '1px solid rgba(var(--accent-blue-rgb), 0.25)',
              color: 'var(--accent-blue)',
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: 0,
            }}>
              <span style={{ fontSize: 11, lineHeight: 1 }}>&#9670;</span>
              AI
            </span>
            <span>Review Chat</span>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'var(--font-mono)' }}>
            {scope ? `${scope.reviewType} · ${scope.reviewId}` : 'No review selected'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-tertiary)', fontSize: 11 }}>
          <span style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: scope && session ? 'var(--accent-green)' : 'var(--accent-yellow)',
            boxShadow: scope && session ? '0 0 10px color-mix(in srgb, var(--accent-green) 42%, transparent)' : 'none',
          }} />
          <span>{statusText}</span>
        </div>
        <button
          type="button"
          onClick={handleClearChat}
          disabled={!canClearChat}
          aria-label="Clear review chat history"
          title="Clear chat history"
          style={{
            border: 'none',
            background: 'transparent',
            color: canClearChat ? 'var(--text-tertiary)' : 'var(--text-disabled, var(--text-tertiary))',
            cursor: canClearChat ? 'pointer' : 'not-allowed',
            opacity: canClearChat ? 1 : 0.45,
            padding: 6,
            display: 'inline-flex',
            borderRadius: 6,
          }}
        >
          <svg width="17" height="17" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close review assistant"
          title="Close"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            padding: 6,
            display: 'inline-flex',
            borderRadius: 6,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {normalizedAttachments.length > 0 && (
        <div style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          padding: '10px 14px',
          borderBottom: '1px solid var(--review-shell-border)',
          background: 'rgba(9, 13, 22, 0.46)',
        }}>
          {normalizedAttachments.map((attachment, index) => (
            <span
              key={`${attachment.type}-${index}-${getReviewAgentAttachmentLabel(attachment)}`}
              style={{
                maxWidth: '100%',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 8px',
                borderRadius: 999,
                border: '1px solid var(--chip-info-border)',
                background: 'var(--chip-info-bg)',
                color: 'var(--text-secondary)',
                fontSize: 10.5,
              }}
              title={getReviewAgentAttachmentLabel(attachment)}
            >
              <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--accent-blue)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getReviewAgentAttachmentLabel(attachment)}
              </span>
            </span>
          ))}
        </div>
      )}

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '18px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          background: 'linear-gradient(180deg, rgba(14, 20, 32, 0.94) 0%, rgba(10, 14, 22, 0.98) 100%)',
        }}
      >
        {isLoading && (
          <div style={{ alignSelf: 'flex-start' }}>
            <TypingDots />
          </div>
        )}
        {!isLoading && messages.length === 0 && (
          <div style={{
            display: 'grid',
            gap: 12,
            padding: 14,
            borderRadius: 10,
            background: 'rgba(20, 27, 40, 0.62)',
            border: '1px solid var(--review-shell-border)',
          }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Ask about this review, selected findings, changed files, or PR conversations.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {promptChips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => sendMessage(chip)}
                  disabled={!session || isStreaming}
                  style={{
                    border: '1px solid var(--review-shell-border-strong)',
                    background: 'var(--review-code-bg)',
                    color: 'var(--text-primary)',
                    borderRadius: 8,
                    padding: '7px 10px',
                    fontSize: 12,
                    cursor: session && !isStreaming ? 'pointer' : 'default',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
                  }}
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.filter(shouldShowReviewAgentMessage).map((message) => (
          message.role === 'system' || message.role === 'tool' ? (
            <div
              key={message.id}
              style={{
                alignSelf: 'flex-start',
                maxWidth: '100%',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px',
                borderRadius: 999,
                background: 'rgba(var(--accent-blue-rgb), 0.08)',
                border: '1px solid rgba(var(--accent-blue-rgb), 0.18)',
                color: 'var(--text-secondary)',
                fontSize: 11,
              }}
            >
              <span style={{ color: 'var(--accent-blue)' }}>›</span>
              <span style={{ overflowWrap: 'anywhere' }}>{message.content}</span>
            </div>
          ) : (
            <div
              key={message.id}
              style={{
                alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '92%',
                minWidth: 0,
                boxSizing: 'border-box',
                border: message.role === 'user'
                  ? '1px solid rgba(31, 184, 220, 0.34)'
                  : '1px solid var(--review-shell-border)',
                background: message.role === 'user'
                  ? 'rgba(17, 55, 66, 0.92)'
                  : 'var(--bg-surface-raised)',
                borderRadius: message.role === 'user' ? 22 : 10,
                padding: message.role === 'user' ? '11px 15px' : '12px 13px',
                color: message.role === 'user' ? '#35d7f6' : 'var(--text-primary)',
                fontSize: 13,
                lineHeight: 1.46,
                overflowWrap: 'anywhere',
                boxShadow: message.role === 'user'
                  ? 'inset 0 1px 0 rgba(255,255,255,0.03)'
                  : '0 8px 20px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.03)',
              }}
            >
              {message.role === 'assistant' ? (
                <>
                  <div
                    className="prose prose-invert prose-sm max-w-none break-words"
                    style={{
                      color: 'var(--text-primary)',
                      maxWidth: '100%',
                      minWidth: 0,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {message.content.trim() ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          p: ({ children }) => <p style={{ margin: '0 0 8px' }}>{children}</p>,
                          ul: ({ children }) => <ul style={{ margin: '0 0 8px 18px', padding: 0 }}>{children}</ul>,
                          ol: ({ children }) => <ol style={{ margin: '0 0 8px 18px', padding: 0 }}>{children}</ol>,
                          li: ({ children }) => <li style={{ marginBottom: 3 }}>{children}</li>,
                          code: ({ inline, children, ...props }: any) => inline ? (
                            <code
                              {...props}
                              style={{
                                padding: '1px 5px',
                                borderRadius: 5,
                                background: 'var(--review-code-bg)',
                                border: '1px solid var(--review-shell-border)',
                                color: 'var(--accent-blue)',
                                fontFamily: 'var(--font-mono)',
                                fontSize: 12,
                                whiteSpace: 'normal',
                                overflowWrap: 'anywhere',
                              }}
                            >
                              {children}
                            </code>
                          ) : (
                            <code
                              {...props}
                              style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 12,
                                whiteSpace: 'pre-wrap',
                                overflowWrap: 'anywhere',
                                wordBreak: 'break-word',
                              }}
                            >
                              {children}
                            </code>
                          ),
                          pre: ({ children }) => (
                            <pre style={{
                              margin: '8px 0',
                              padding: 10,
                              borderRadius: 8,
                              overflowX: 'auto',
                              maxWidth: '100%',
                              boxSizing: 'border-box',
                              whiteSpace: 'pre-wrap',
                              overflowWrap: 'anywhere',
                              wordBreak: 'break-word',
                              background: 'var(--review-code-bg)',
                              border: '1px solid var(--review-shell-border)',
                            }}>
                              {children}
                            </pre>
                          ),
                          a: ({ children, href }) => (
                            <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-blue)', textDecoration: 'underline' }}>
                              {children}
                            </a>
                          ),
                          blockquote: ({ children }) => (
                            <blockquote style={{
                              margin: '8px 0',
                              paddingLeft: 10,
                              borderLeft: '3px solid var(--accent-blue)',
                              color: 'var(--text-secondary)',
                            }}>
                              {children}
                            </blockquote>
                          ),
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    ) : (
                      <TypingDots />
                    )}
                    {message.isStreaming && message.content.trim() && (
                      <span style={{ display: 'inline-block', width: 8, height: 16, marginLeft: 4, background: 'currentColor', opacity: 0.6, animation: 'review-agent-dot-pulse 1s ease-in-out infinite' }} />
                    )}
                  </div>
                  <ToolUseDisclosure tools={getMessageToolUses(message)} />
                  {getMessageActions(message).map((action, actionIndex) => {
                    const actionKey = getReviewAgentActionKey(action, actionIndex);
                    const actionResult = message.meta?.actionResults?.[actionKey];
                    const onRecordActionResult = (resultKey: string, result: ReviewAgentActionResult) => {
                      recordActionResult(message.id, resultKey, result);
                    };
                    return action.type === 'draft_pr_reply' ? (
                      <DraftPrReplyActionCard
                        key={`${action.threadNodeId}-${actionIndex}`}
                        action={action}
                        scope={scope}
                        actionKey={actionKey}
                        actionResult={actionResult}
                        onRecordActionResult={onRecordActionResult}
                      />
                    ) : action.type === 'fix_findings' ? (
                      <FixFindingsActionCard
                        key={`${action.recommendationKeys.join('|')}-${actionIndex}`}
                        action={action}
                        onFixFindings={onFixFindings}
                        actionKey={actionKey}
                        actionResult={actionResult}
                        onRecordActionResult={onRecordActionResult}
                      />
                    ) : action.type === 'run_review' ? (
                      <RunReviewActionCard
                        key={`run-review-${action.mode || 'standard'}-${actionIndex}`}
                        action={action}
                        onRunReview={onRunReview}
                        actionKey={actionKey}
                        actionResult={actionResult}
                        onRecordActionResult={onRecordActionResult}
                      />
                    ) : action.type === 'set_outcome' ? (
                      <SetOutcomeActionCard
                        key={`set-outcome-${action.recommendationKey}-${actionIndex}`}
                        action={action}
                        onSetOutcome={onSetOutcome}
                        actionKey={actionKey}
                        actionResult={actionResult}
                        onRecordActionResult={onRecordActionResult}
                      />
                    ) : action.type === 'publish_pr_review' ? (
                      <PublishPrReviewActionCard
                        key={`publish-pr-review-${action.action}-${actionIndex}`}
                        action={action}
                        scope={scope}
                        onPublishPrReview={onPublishPrReview}
                        actionKey={actionKey}
                        actionResult={actionResult}
                        onRecordActionResult={onRecordActionResult}
                      />
                    ) : null;
                  })}
                  <div style={{ marginTop: 6, fontSize: 10.5, color: 'var(--text-tertiary)' }}>
                    {formatReviewAgentTime(message.createdAt)}
                  </div>
                </>
              ) : (
                <>
                  {renderSelectedCodeAttachments(getMessageAttachments(message), true)}
                  <div style={{ whiteSpace: 'pre-wrap' }}>{message.content}</div>
                  <div style={{ marginTop: 6, fontSize: 10.5, color: 'rgba(184, 244, 255, 0.56)' }}>
                    {formatReviewAgentTime(message.createdAt)}
                  </div>
                </>
              )}
            </div>
          )
        ))}
        {showTypingIndicator && (
          <div style={{ alignSelf: 'flex-start' }}>
            <TypingDots message={progressMessage} />
          </div>
        )}
      </div>

      {error && (
        <div style={{
          margin: '0 14px 10px',
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid color-mix(in srgb, var(--accent-red) 36%, transparent)',
          background: 'color-mix(in srgb, var(--accent-red) 10%, transparent)',
          color: 'var(--accent-red)',
          fontSize: 11,
          lineHeight: 1.4,
        }}>
          {error}
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          sendMessage(draft);
        }}
        style={{
          padding: 14,
          borderTop: '1px solid var(--review-shell-border)',
          background: 'var(--review-panel-header-bg)',
          display: 'grid',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            border: '1px solid var(--review-shell-border)',
            borderRadius: 10,
            background: 'var(--review-code-bg)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
            padding: 10,
          }}
        >
          {renderSelectedCodeAttachments(selectedCodeAttachments)}
          <textarea
            ref={inputRef}
            value={isStreaming ? '' : draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={isStreaming ? 'Processing your request...' : 'Ask about this review...'}
            rows={2}
            disabled={isStreaming || !scope || !session}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              minHeight: 56,
              maxHeight: 180,
              border: 'none',
              padding: 0,
              background: 'transparent',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
              lineHeight: 1.45,
              outline: 'none',
              userSelect: 'text',
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage(draft);
              }
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 9 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Review-scoped assistant
              </span>
            </div>
            {isStreaming ? (
              <button
                type="button"
                onClick={stop}
                title="Stop"
                style={{
                  border: 'none',
                  background: 'var(--accent-red)',
                  color: '#fff',
                  borderRadius: 8,
                  width: 42,
                  height: 42,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                title="Send"
                style={{
                  border: 'none',
                  background: canSend ? 'var(--accent-blue)' : 'var(--bg-surface-raised)',
                  color: canSend ? '#fff' : 'var(--text-tertiary)',
                  borderRadius: 8,
                  width: 42,
                  height: 42,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: canSend ? 'pointer' : 'default',
                  flexShrink: 0,
                }}
              >
                <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </form>
      {codePreview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Selected code preview"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCodePreview(null);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: 'rgba(0, 0, 0, 0.46)',
          }}
        >
          <div style={{
            width: 'min(760px, calc(100vw - 48px))',
            maxHeight: 'min(720px, calc(100vh - 48px))',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: 12,
            border: '1px solid var(--review-shell-border-strong)',
            background: 'var(--bg-surface-raised)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.52)',
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 14px',
              borderBottom: '1px solid var(--review-shell-border)',
              background: 'var(--review-panel-header-bg)',
            }}>
              <span style={{
                width: 34,
                height: 28,
                borderRadius: 7,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                border: '1px solid rgba(var(--accent-blue-rgb), 0.28)',
                background: 'rgba(var(--accent-blue-rgb), 0.12)',
                color: 'var(--accent-blue)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                fontWeight: 800,
              }}>
                CODE
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  fontWeight: 700,
                }}>
                  {codePreview.path}
                </div>
                <div style={{ color: 'var(--text-tertiary)', fontSize: 11, marginTop: 2 }}>
                  Lines {codePreview.startLine}-{codePreview.endLine}{codePreview.side ? ` · ${codePreview.side}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCodePreview(null)}
                aria-label="Close selected code preview"
                title="Close"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: 6,
                  display: 'inline-flex',
                  borderRadius: 6,
                }}
              >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
            <pre style={{
              margin: 0,
              padding: 16,
              overflow: 'auto',
              color: 'var(--text-primary)',
              background: 'var(--review-code-bg)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}>
              {String(codePreview.selectedText || '').trim()}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default ReviewAgentDrawer;
