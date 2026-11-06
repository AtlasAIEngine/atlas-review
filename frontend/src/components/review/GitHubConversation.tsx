import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openExternal } from '@/utils/openExternal';
import type { GitHubPrConversations, GitHubPrReviewThread, GitHubPrThreadComment } from '@/types';

export const PR_REVIEW_CONVERSATIONS_UPDATED_EVENT = 'atlas:pr-review-conversations-updated';

export interface PrReviewConversationsUpdatedDetail {
  projectId: string;
  prReviewId: string;
  conversations: GitHubPrConversations | null;
}

const PR_CONVERSATION_AUTO_SYNC_STALE_MS = 2 * 60 * 1000;
export const GITHUB_CONVERSATION_RETRY_DELAY_MS = 1200;
const GITHUB_CONVERSATION_RETRY_MESSAGE = 'GitHub timed out while loading conversations. Retrying...';
const GITHUB_CONVERSATION_TIMEOUT_MESSAGE = 'GitHub timed out while loading conversations. Try syncing again in a moment.';
const GITHUB_CONVERSATION_HTML_ERROR_MESSAGE = 'GitHub returned a temporary HTML error page while loading conversations. Try syncing again in a moment.';

export type GitHubConversationSide = 'LEFT' | 'RIGHT';

export interface GitHubConversationDiffTarget {
  path: string;
  line: number | null;
  side: GitHubConversationSide;
}

function normalizePositiveLine(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : null;
}

function normalizeConversationSide(value: unknown): GitHubConversationSide {
  return String(value || '').toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
}

function firstThreadComment(thread: GitHubPrReviewThread): GitHubPrThreadComment | null {
  return Array.isArray(thread.comments) && thread.comments.length > 0
    ? thread.comments[0]
    : null;
}

export function getGitHubConversationDiffTarget(thread: GitHubPrReviewThread): GitHubConversationDiffTarget | null {
  const firstComment = firstThreadComment(thread);
  const path = String(thread.path || firstComment?.path || '').trim();
  if (!path) return null;

  const side = normalizeConversationSide(thread.side || firstComment?.side);
  const line = side === 'LEFT'
    ? (
        normalizePositiveLine(thread.originalLine)
        || normalizePositiveLine(thread.originalStartLine)
        || normalizePositiveLine(thread.line)
        || normalizePositiveLine(thread.startLine)
        || normalizePositiveLine(firstComment?.line)
        || normalizePositiveLine(firstComment?.startLine)
      )
    : (
        normalizePositiveLine(thread.line)
        || normalizePositiveLine(thread.startLine)
        || normalizePositiveLine(firstComment?.line)
        || normalizePositiveLine(firstComment?.startLine)
        || normalizePositiveLine(thread.originalLine)
        || normalizePositiveLine(thread.originalStartLine)
      );

  return { path, line, side };
}

export function shouldAutoSyncGitHubConversations(
  conversations: GitHubPrConversations | null | undefined,
  staleAfterMs = PR_CONVERSATION_AUTO_SYNC_STALE_MS,
): boolean {
  const syncedAt = conversations?.summary?.syncedAt || conversations?.sync?.syncedAt || null;
  if (!syncedAt) return true;
  const syncedAtMs = new Date(syncedAt).getTime();
  if (!Number.isFinite(syncedAtMs)) return true;
  return Date.now() - syncedAtMs > staleAfterMs;
}

function getErrorPayloadText(error: unknown): string {
  const responseData = (error as { response?: { data?: unknown } } | null)?.response?.data;
  if (typeof responseData === 'string') return responseData;
  if (responseData && typeof responseData === 'object') {
    const payload = responseData as { error?: unknown; message?: unknown; details?: unknown };
    for (const value of [payload.error, payload.message, payload.details]) {
      if (typeof value === 'string' && value.trim()) return value;
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return '';
}

function isGitHubHtmlTimeoutMessage(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes("we couldn't respond to your request in time")
    || lower.includes('we could not respond to your request in time');
}

function isHtmlErrorMessage(value: string): boolean {
  return /^\s*<!doctype\s+html\b/i.test(value)
    || /^\s*<html(?:\s|>)/i.test(value)
    || /hello future githubber/i.test(value);
}

export function describeGitHubConversationLoadError(error: unknown): string {
  const text = getErrorPayloadText(error);
  if (text) {
    if (isGitHubHtmlTimeoutMessage(text)) return GITHUB_CONVERSATION_TIMEOUT_MESSAGE;
    if (isHtmlErrorMessage(text)) return GITHUB_CONVERSATION_HTML_ERROR_MESSAGE;
    return text;
  }
  return 'Failed to load GitHub conversations';
}

export function describeGitHubConversationRetry(error: unknown): string {
  const text = getErrorPayloadText(error);
  if (text && isGitHubHtmlTimeoutMessage(text)) return GITHUB_CONVERSATION_RETRY_MESSAGE;
  return 'GitHub conversations did not load. Retrying...';
}

export function isRetryableGitHubConversationLoadError(error: unknown): boolean {
  const status = Number((error as { response?: { status?: unknown } } | null)?.response?.status);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String((error as { code?: unknown } | null)?.code || '').trim().toUpperCase();
  if (['ECONNABORTED', 'ERR_NETWORK', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) return true;
  const text = getErrorPayloadText(error);
  if (!text) return false;
  return isGitHubHtmlTimeoutMessage(text)
    || isHtmlErrorMessage(text)
    || /\b(timeout|timed out|temporarily unavailable|try again later)\b/i.test(text);
}

export function formatGitHubConversationTime(value: string | null | undefined): string {
  if (!value) return 'Unknown time';
  return formatGitHubConversationRelativeTime(value);
}

export function formatGitHubConversationExactTime(value: string | null | undefined): string {
  if (!value) return 'Unknown time';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown time';
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: parsed.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatGitHubConversationRelativeTime(value: string | null | undefined): string {
  if (!value) return 'Unknown time';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown time';
  const diffMs = Date.now() - timestamp;
  const absMs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? 'ago' : 'from now';
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;
  if (absMs < 45_000) return diffMs >= 0 ? 'just now' : 'in a few seconds';
  if (absMs < hour) {
    const count = Math.max(1, Math.round(absMs / minute));
    return `${count} minute${count === 1 ? '' : 's'} ${suffix}`;
  }
  if (absMs < day) {
    const count = Math.max(1, Math.round(absMs / hour));
    return `${count} hour${count === 1 ? '' : 's'} ${suffix}`;
  }
  if (absMs < month) {
    const count = Math.max(1, Math.round(absMs / day));
    return `${count} day${count === 1 ? '' : 's'} ${suffix}`;
  }
  if (absMs < year) {
    const count = Math.max(1, Math.round(absMs / month));
    return `${count} month${count === 1 ? '' : 's'} ${suffix}`;
  }
  const count = Math.max(1, Math.round(absMs / year));
  return `${count} year${count === 1 ? '' : 's'} ${suffix}`;
}

function getGitHubConversationInitials(login: string | null | undefined): string {
  const normalized = String(login || 'GH').trim();
  if (!normalized) return 'GH';
  return normalized.slice(0, 2).toUpperCase();
}

export function GitHubConversationAvatar({
  avatarUrl,
  login,
  size = 24,
}: {
  avatarUrl?: string | null;
  login?: string | null;
  size?: number;
}) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={login ? `${login} avatar` : 'GitHub avatar'}
        loading="lazy"
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          border: '1px solid var(--border-default)',
          flexShrink: 0,
          background: 'var(--review-panel-alt-bg)',
        }}
      />
    );
  }

  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      border: '1px solid var(--border-default)',
      background: 'var(--review-panel-alt-bg)',
      color: 'var(--text-tertiary)',
      display: 'grid',
      placeItems: 'center',
      flexShrink: 0,
      fontSize: Math.max(8, Math.floor(size * 0.38)),
      fontWeight: 700,
    }}>
      {getGitHubConversationInitials(login)}
    </div>
  );
}

export function normalizeGitHubConversationMarkdown(value: string | null | undefined): string {
  return String(value || '')
    .replace(/<\/?sub>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type GitHubConversationMarkdownPart =
  | { type: 'markdown'; value: string }
  | { type: 'suggestion'; value: string };

function splitGitHubSuggestionBlocks(markdown: string): GitHubConversationMarkdownPart[] {
  const source = String(markdown || '');
  const pattern = /(^|\n)(`{3,}|~{3,})suggestion[^\n]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/gi;
  const parts: GitHubConversationMarkdownPart[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const leadingNewline = match[1] || '';
    const blockStart = match.index + leadingNewline.length;
    const before = source.slice(cursor, blockStart).trim();
    if (before) parts.push({ type: 'markdown', value: before });
    const suggestion = String(match[3] || '').replace(/\n+$/g, '');
    parts.push({ type: 'suggestion', value: suggestion });
    cursor = pattern.lastIndex;
  }
  const after = source.slice(cursor).trim();
  if (after) parts.push({ type: 'markdown', value: after });
  return parts.length > 0 ? parts : [{ type: 'markdown', value: source }];
}

function renderMarkdown(markdown: string, key?: string) {
  return (
    <ReactMarkdown
      key={key}
      remarkPlugins={[remarkGfm]}
      urlTransform={defaultUrlTransform}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (href) void openExternal(href);
            }}
          >
            {children}
          </a>
        ),
        img: ({ alt }) => {
          const normalizedAlt = String(alt || 'image').trim();
          const priorityMatch = normalizedAlt.match(/^(P\d+)\s+Badge$/i);
          if (priorityMatch) {
            return (
              <span className="github-conversation-priority-badge">
                {priorityMatch[1].toUpperCase()}
              </span>
            );
          }
          return (
            <span className="github-conversation-image-alt">
              {normalizedAlt}
            </span>
          );
        },
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function GitHubConversationSuggestionBlock({ suggestion }: { suggestion: string }) {
  const lines = suggestion.split('\n');
  return (
    <div className="github-conversation-suggestion">
      <div className="github-conversation-suggestion-header">Suggested change</div>
      <div className="github-conversation-suggestion-body">
        {lines.length > 0 ? lines.map((line, index) => (
          <div key={`${index}-${line}`} className="github-conversation-suggestion-line">
            <span className="github-conversation-suggestion-marker">+</span>
            <code>{line || ' '}</code>
          </div>
        )) : (
          <div className="github-conversation-suggestion-line">
            <span className="github-conversation-suggestion-marker">+</span>
            <code> </code>
          </div>
        )}
      </div>
    </div>
  );
}

export function GitHubConversationMarkdown({ body }: { body: string | null | undefined }) {
  const markdown = normalizeGitHubConversationMarkdown(body) || '_No comment body_';
  const parts = splitGitHubSuggestionBlocks(markdown);

  return (
    <div className="github-conversation-markdown">
      {parts.map((part, index) => (
        part.type === 'suggestion'
          ? <GitHubConversationSuggestionBlock key={`suggestion-${index}`} suggestion={part.value} />
          : renderMarkdown(part.value, `markdown-${index}`)
      ))}
    </div>
  );
}
