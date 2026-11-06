/**
 * Chat Panel Component
 * Chat interface for Claude Code interaction with persistent history
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import axios from 'axios';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { chatApi, uiEditsApi, cliAdaptersApi, providerApi, getApiBaseUrl, getSocketAuth, type UploadedFile, type CLIAdapter } from '@/services/api';
import type { UiEditPayload, UiSelection, ChatMode, AIProvider } from '@/types';
import toast from '@/lib/toast';
import { ActionStrip } from './ActionStrip';
import { groupChatTimeline, type GroupedTurn } from '@/utils/chatGrouping';
import { MarkdownBuffer } from '@/utils/markdownBuffer';
import { buildCompletionSummary } from '@/utils/routeDetection';
import { extractRouteFromAtlasHref } from '@/utils/previewNavigation';
import { usePopup } from './shared/PopupProvider';
import { pickPreferredBuildModelKey } from '@/utils/buildProviderSelection';
import { isProviderUsable } from '@/utils/providerStatus';
import { isTauriEnvironment } from '@/utils/tauri';
import { shouldApplyChatRecovery } from '@/utils/chatRecovery';
import { formatShortcut } from '@/utils/keyboardShortcuts';
import { classifyToolOperation } from '@shared/toolOperationClassifier.js';

interface ChatPanelProps {
  projectId: string;
  onProjectRenamed?: (projectId: string, name: string) => void;
  onFileChange?: () => void; // Callback when previewable files are modified
  onFileTreeChange?: () => void; // Callback when the file tree structure changes
  uiSelection?: UiSelection | null;
  isSelectingUi?: boolean;
  onStartUiSelection?: () => void;
  onClearUiSelection?: () => void;
  onApplyUiEdit?: (payload: UiEditPayload) => void;
  onResetUiEdit?: () => void;
  onUiEditsSaved?: () => void;
  isCapturingScreenshot?: boolean;
  onStartScreenshot?: () => void;
  onCancelScreenshot?: () => void;
  pendingScreenshotFile?: File | null;
  onScreenshotFileConsumed?: () => void;
  initialPrompt?: string | null;
  initialFiles?: File[];
  initialPromptMode?: ChatMode;
  initialPromptProviderType?: string | null;
  initialPromptModelAlias?: string | null;
  initialPromptRequestId?: string | null;
  onInitialPromptConsumed?: () => void;
  // External system messages (local-only, not sent to LLM)
  pendingSystemMessage?: { content: string; tone?: 'success' | 'error' | 'warning' } | null;
  onSystemMessageConsumed?: () => void;
}

interface FileDiff {
  filePath: string;
  beforeContent: string | null;
  afterContent: string;
  isNewFile: boolean;
  language: string;
  stats: { additions: number; deletions: number };
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: any;
  toolId?: string;
  attachments?: UploadedFile[];
  clientRequestId?: string;
  tone?: 'success' | 'error' | 'warning';
  fileDiff?: FileDiff;
  mode?: 'plan' | 'build' | 'agent';  // Mode when message was created
  tokensUsed?: number;
  model?: string;
}

/** Extract <think>/<thinking> blocks from the start of assistant content */
function splitThinkingContent(content: string): { thinking: string | null; body: string } {
  // Match <think> or <thinking> tags at the start of the message
  const thinkRegex = /^<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\s*/;
  const match = content.match(thinkRegex);
  if (match) {
    return { thinking: match[1].trim(), body: content.slice(match[0].length) };
  }
  return { thinking: null, body: content };
}

/** Estimate cost from token count and model name */
function estimateCost(tokens: number, model?: string): string {
  const m = (model || '').toLowerCase();
  let rate = 0.000015; // default sonnet-class
  if (m.includes('haiku')) rate = 0.00000125;
  else if (m.includes('opus')) rate = 0.000075;
  const cost = tokens * rate;
  if (cost < 0.01) return `<$0.01`;
  return `~$${cost.toFixed(2)}`;
}

/** Check if a URL points to a dev server managed by Atlas (port pool 3001-3100) */
function isDevServerUrl(href: string | undefined): boolean {
  if (!href) return false;
  try {
    const url = new URL(href);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return false;
    const port = parseInt(url.port, 10);
    return port >= 3001 && port <= 3100;
  } catch {
    return false;
  }
}

interface SlashCommand {
  name: string;
  command: string;
  description?: string;
  argumentHint?: string | null;
  scope: 'project' | 'user' | 'builtin';
  namespace?: string | null;
  type: 'custom' | 'builtin';
  supported?: boolean;
}

const PAGE_SIZE = 20;

interface UiEditDraft {
  text: string;
  placeholder: string;
  value: string;
  styles: Record<string, string>;
}

interface BuildModelOption {
  key: string;
  providerType: string;
  providerName: string;
  alias: string;
  name: string;
  description: string;
  isDefault: boolean;
}

const STYLE_FIELDS: Array<{ key: string; label: string; placeholder?: string }> = [
  { key: 'color', label: 'Text color', placeholder: '#hex, rgb(), name' },
  { key: 'backgroundColor', label: 'Background', placeholder: '#hex, rgb(), name' },
  { key: 'fontSize', label: 'Font size', placeholder: 'px, rem, em' },
  { key: 'fontWeight', label: 'Font weight', placeholder: '400, 600, bold' },
  { key: 'lineHeight', label: 'Line height', placeholder: '1.5, 150%, 24px' },
  { key: 'textAlign', label: 'Text align', placeholder: 'left, center, right' },
  { key: 'padding', label: 'Padding', placeholder: 'px, rem, em' },
  { key: 'margin', label: 'Margin', placeholder: 'px, rem, auto' },
  { key: 'borderRadius', label: 'Radius', placeholder: 'px, rem, 50%' },
];

// Simple unique ID generator
const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const FILE_PATH_KEYS = new Set([
  'file_path',
  'filepath',
  'path',
  'target_file',
  'targetpath',
  'destination',
  'output',
  'output_path',
  'outputpath',
  'from',
  'to',
]);

const READ_ONLY_TOOL_NAME_RE = /\b(read|search|grep|glob|find|list|ls|reasoning)\b/i;
const MUTATING_TOOL_NAME_RE = /\b(write|edit|patch|create|delete|rename|move|update|modify|replace)\b/i;
const STRUCTURAL_BASH_COMMAND_RE = /\b(mkdir|touch|mv|cp|install\s+-D)\b/;
const KNOWN_FILE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'csv', 'env', 'gif', 'go', 'h', 'hpp', 'html', 'ico', 'ini',
  'java', 'jpeg', 'jpg', 'js', 'json', 'jsx', 'kt', 'less', 'log', 'lock', 'lua', 'mjs', 'md',
  'mdx', 'php', 'png', 'ps1', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svg', 'svelte', 'swift',
  'toml', 'ts', 'tsx', 'txt', 'vue', 'webp', 'xml', 'yaml', 'yml', 'zsh',
]);

function looksLikeFilePath(value: string): boolean {
  const candidate = value.trim();
  if (!candidate) return false;
  if (candidate.length > 400 || candidate.includes('\n')) return false;
  if (candidate.startsWith('http://') || candidate.startsWith('https://') || candidate.includes('://')) return false;
  if (candidate.startsWith('{') || candidate.startsWith('[')) return false;
  if (candidate.includes('/') || candidate.includes('\\')) return true;
  const extMatch = candidate.match(/\.([a-z0-9]{1,10})$/i);
  if (!extMatch) return false;
  return KNOWN_FILE_EXTENSIONS.has(extMatch[1].toLowerCase());
}

function collectFilePathsFromToolInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const found = new Set<string>();
  const queue: unknown[] = [input];
  let inspected = 0;

  while (queue.length > 0 && inspected < 50) {
    inspected += 1;
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;

    if (Array.isArray(current)) {
      for (const item of current) {
        if (typeof item === 'string' && looksLikeFilePath(item)) {
          found.add(item.trim());
        } else if (item && typeof item === 'object') {
          queue.push(item);
        }
      }
      continue;
    }

    for (const [rawKey, value] of Object.entries(current)) {
      const key = rawKey.toLowerCase();
      if (FILE_PATH_KEYS.has(key)) {
        if (typeof value === 'string' && looksLikeFilePath(value)) {
          found.add(value.trim());
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string' && looksLikeFilePath(item)) {
              found.add(item.trim());
            }
          }
        }
      }

      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return Array.from(found);
}

function isLikelyMutatingTool(toolName: string | undefined, toolInput: any): boolean {
  const classification = classifyToolOperation(toolName, toolInput);
  const normalizedName = classification.normalizedName;
  if (!normalizedName) return false;

  if (classification.mutatesFiles) {
    return true;
  }

  if (READ_ONLY_TOOL_NAME_RE.test(normalizedName)) return false;
  return MUTATING_TOOL_NAME_RE.test(normalizedName);
}

function shouldTriggerFileTreeRefreshFromToolUse(
  toolName: string | undefined,
  toolInput: any,
  collectedPaths: string[],
): boolean {
  const normalizedName = String(toolName || '').trim().toLowerCase();
  if (!normalizedName) return false;

  if (normalizedName === 'write') {
    return Boolean(
      (collectedPaths.length > 0) && (
        toolInput?.isNewFile
        || toolInput?.create
        || toolInput?.newFile
        || toolInput?.createNew
        || toolInput?.overwrite === false
      )
    );
  }

  if (normalizedName === 'bash') {
    const command = String(toolInput?.command || '');
    return STRUCTURAL_BASH_COMMAND_RE.test(command);
  }

  return false;
}

function ScreenshotHint() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent-purple/15 border border-accent-purple/30 text-xs text-content-secondary animate-in fade-in">
      <svg className="w-4 h-4 text-accent-purple flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
      Drag to select area in preview for screenshot
    </div>
  );
}

/** Lightbox overlay for previewing images */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-white/70 hover:text-white text-2xl w-10 h-10 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors"
        title="Close (Esc)"
      >
        &times;
      </button>
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

function ChatPanel({
  projectId,
  onProjectRenamed,
  onFileChange,
  onFileTreeChange,
  uiSelection,
  isSelectingUi,
  onStartUiSelection,
  onClearUiSelection,
  onApplyUiEdit,
  onResetUiEdit,
  onUiEditsSaved,
  isCapturingScreenshot,
  onStartScreenshot,
  onCancelScreenshot,
  pendingScreenshotFile,
  onScreenshotFileConsumed,
  initialPrompt,
  initialFiles = [],
  initialPromptMode,
  initialPromptProviderType = null,
  initialPromptModelAlias = null,
  initialPromptRequestId = null,
  onInitialPromptConsumed,
  pendingSystemMessage,
  onSystemMessageConsumed,
}: ChatPanelProps) {
  const popup = usePopup();
  const chatModeShortcut = formatShortcut(['primary', 'shift', 'P']);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [showSelectMenu, setShowSelectMenu] = useState(false);
  const selectMenuRef = useRef<HTMLDivElement>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [currentActivity, setCurrentActivity] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);

  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [commandMatches, setCommandMatches] = useState<SlashCommand[]>([]);
  const [commandAnchor, setCommandAnchor] = useState<{ start: number; end: number } | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [uiEditDraft, setUiEditDraft] = useState<UiEditDraft | null>(null);
  const [uiEditInitial, setUiEditInitial] = useState<UiEditDraft | null>(null);
  const [uiEditSavedPayload, setUiEditSavedPayload] = useState<UiEditPayload | null>(null);
  const [isLocalEditorOpen, setIsLocalEditorOpen] = useState(false);
  const [isSavingEdits, setIsSavingEdits] = useState(false);
  const [authStatus, setAuthStatus] = useState<{
    authenticated: boolean;
    error?: string;
    checking?: boolean;
    provider?: string;
  } | null>(null);
  const buildAttachmentPreviewUrl = useCallback((attachment: UploadedFile) => {
    const attachmentPath = attachment.path || attachment.relativePath;
    return `${getApiBaseUrl()}/projects/${projectId}/attachments/raw?path=${encodeURIComponent(attachmentPath)}`;
  }, [projectId]);

  const renderMessageAttachments = useCallback((attachments: UploadedFile[]) => (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {attachments.map((att, i) => {
        const ext = att.originalName.split('.').pop()?.toLowerCase() || '';
        const isImage = att.mimetype.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
        const icon = isImage ? '🖼' : ext === 'pdf' ? '📕' : ['doc', 'docx'].includes(ext) ? '📘' : ['xls', 'xlsx'].includes(ext) ? '📗' : '📄';
        const attachmentUrl = buildAttachmentPreviewUrl(att);

        return isImage ? (
          <button
            key={`${att.path || att.relativePath || att.originalName}-${i}`}
            className="group relative rounded overflow-hidden border border-white/10 hover:border-accent-blue/50 transition-colors cursor-pointer"
            style={{ background: 'rgba(53, 215, 246, 0.08)' }}
            title={`${att.originalName} — click to preview`}
            onClick={() => setLightboxImage({ src: attachmentUrl, alt: att.originalName })}
          >
            <img
              src={attachmentUrl}
              alt={att.originalName}
              className="w-24 h-16 object-cover"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
              <svg className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
                <path d="M11 8v6M8 11h6" />
              </svg>
            </div>
            <div className="px-1.5 py-0.5 text-[10px] truncate max-w-[96px]" style={{ color: '#b8f4ff' }}>
              {att.originalName}
            </div>
          </button>
        ) : (
          <div
            key={`${att.path || att.relativePath || att.originalName}-${i}`}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs max-w-[200px]"
            style={{ background: 'rgba(53, 215, 246, 0.12)', color: '#b8f4ff' }}
            title={att.originalName}
          >
            <span className="flex-shrink-0">{icon}</span>
            <span className="truncate">{att.originalName}</span>
          </div>
        );
      })}
    </div>
  ), [buildAttachmentPreviewUrl]);
  const [availableModels, setAvailableModels] = useState<BuildModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    // Lazy initialization: read from localStorage before any effects run
    try {
      const combined = localStorage.getItem('atlas_selected_cli_model');
      if (combined) {
        return combined;
      }
      const storedModel = localStorage.getItem('atlas_selected_model');
      const storedProvider = localStorage.getItem('atlas_selected_cli');
      if (storedModel && storedProvider && storedModel !== 'auto') {
        return `${storedProvider}:${storedModel}`;
      }
    } catch {
      // localStorage unavailable
    }
    return '';
  });
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelDropdownWidth, setModelDropdownWidth] = useState<number>(60);
  const [availableCLIs, setAvailableCLIs] = useState<CLIAdapter[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<AIProvider[]>([]);
  const [buildContextActive, setBuildContextActive] = useState<{ providerId: string; model: string | null } | null>(null);
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    // Lazy initialization: read from localStorage before any effects run
    try {
      const stored = localStorage.getItem('atlas_chat_mode');
      if (stored === 'agent' || stored === 'plan' || stored === 'build') {
        return stored;
      }
    } catch {
      // localStorage unavailable
    }
    return 'agent';
  });
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());
  const [showPlanActions, setShowPlanActions] = useState(false);
  const [sessionMessageCount, setSessionMessageCount] = useState(0);
  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const mdBufferRef = useRef(new MarkdownBuffer());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ id: string; content: string }>>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [virtuosoFirstItemIndex, setVirtuosoFirstItemIndex] = useState(100000);
  const fileOperationsOccurredRef = useRef(false);
  const requestChangedFilesRef = useRef<Set<string>>(new Set());
  const requestChangesetRef = useRef<{
    id?: string;
    title?: string;
    fileCount?: number;
    filePaths?: string[];
  } | null>(null);
  const requestToolUseCountRef = useRef(0);
  const requestSawAssistantTextRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingRecoveryRef = useRef<{ content: string; startedAt?: string } | null>(null);
  const isLoadingHistoryRef = useRef(true);
  const isLoadingMoreRef = useRef(false);
  const suppressAutoScrollRef = useRef(false);
  const chatModeRef = useRef<ChatMode>(chatMode);
  const lastRequestModeRef = useRef<ChatMode>(chatMode);
  const initialPromptSentRef = useRef(false);
  const isProcessingRef = useRef(false);
  const currentActivityRef = useRef('');
  const isRecoveryProcessingRef = useRef(false);
  const hasConversationStateRef = useRef(false);
  const onFileChangeRef = useRef(onFileChange);
  const onFileTreeChangeRef = useRef(onFileTreeChange);
  const pendingFileRefreshTimeoutsRef = useRef<number[]>([]);
  const pendingFileTreeRefreshTimeoutRef = useRef<number | null>(null);

  // Compute grouped turns for conversation-first display
  const groupedTurns = useMemo<GroupedTurn[]>(() => {
    return groupChatTimeline(messages);
  }, [messages]);

  // Build message-ID → turn-index lookup for search scroll
  const messageIdToTurnIndex = useMemo(() => {
    const map = new Map<string, number>();
    groupedTurns.forEach((turn, idx) => {
      if (turn.userMessage) map.set(turn.userMessage.id, idx);
      if (turn.assistantMessage) map.set(turn.assistantMessage.id, idx);
      turn.toolEvents.forEach(e => { if (e.id) map.set(e.id, idx); });
    });
    return map;
  }, [groupedTurns]);

  // Scroll to a message by ID using Virtuoso's index-based scrolling
  const scrollToMessageId = useCallback((messageId: string) => {
    const turnIndex = messageIdToTurnIndex.get(messageId);
    if (turnIndex !== undefined && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: turnIndex, behavior: 'smooth', align: 'center' });
    }
  }, [messageIdToTurnIndex]);

  const selectedModelOption = useMemo(
    () => availableModels.find((model) => model.key === selectedModel) || null,
    [availableModels, selectedModel]
  );

  // Get stable anchor ID for a turn (used for scroll position preservation during paging)
  const getTurnAnchorId = (turn: GroupedTurn): string => {
    // Use first available message ID as anchor
    if (turn.userMessage) return turn.userMessage.id;
    if (turn.assistantMessage) return turn.assistantMessage.id;
    if (turn.toolEvents.length > 0) return turn.toolEvents[0].id;
    return turn.id; // Fallback to turn ID
  };

  // Toggle expansion state for a turn
  const handleToggleTurn = (turnId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  };

  const formatHistoryMessages = (rawMessages: any[]): Message[] => {
    const historyMessages: Message[] = [];

    for (const msg of rawMessages) {
      if (msg.meta && msg.meta.toolUseEvents && Array.isArray(msg.meta.toolUseEvents)) {
        for (const toolEvent of msg.meta.toolUseEvents) {
          // Include file_diff from database if available (for Write/Edit tools)
          const fileDiff = msg.file_diff ? {
            filePath: msg.file_diff.filePath,
            beforeContent: msg.file_diff.beforeContent,
            afterContent: msg.file_diff.afterContent,
            isNewFile: msg.file_diff.isNewFile,
            language: msg.file_diff.language,
            stats: msg.file_diff.stats,
          } : undefined;

          historyMessages.push({
            id: `${msg.id}-tool-${toolEvent.id}`,
            role: 'assistant',
            content: '',
            timestamp: new Date(msg.created_at),
            isToolUse: true,
            toolName: toolEvent.name,
            toolInput: toolEvent.input,
            toolId: toolEvent.id,
            fileDiff,
          });
        }
      }

      const rawAttachments = msg.meta?.attachments;
      const attachments: UploadedFile[] | undefined =
        Array.isArray(rawAttachments) && rawAttachments.length > 0
          ? rawAttachments.map((a: any) => {
              if (typeof a === 'string') {
                const rawName = a.split('/').pop() || a;
                // Strip multer timestamp prefix (e.g., "1772856346025-CLAUDE.md" → "CLAUDE.md")
                const originalName = rawName.replace(/^\d{13,}-/, '');
                return { filename: rawName, originalName, path: a, mimetype: '', size: 0, relativePath: '' };
              }
              return a;
            })
          : undefined;

      if ((msg.content && msg.content.trim()) || (attachments && attachments.length > 0)) {
        historyMessages.push({
          id: msg.id,
          role: msg.role,
          content: msg.content || '',
          timestamp: new Date(msg.created_at),
          tone:
            msg.role === 'system' && msg.meta && ['success', 'error'].includes(msg.meta.tone)
              ? msg.meta.tone
              : undefined,
          tokensUsed: msg.tokens_used || undefined,
          model: msg.model || undefined,
          attachments,
          clientRequestId: msg.meta?.clientRequestId || undefined,
        });
      }
    }

    return historyMessages;
  };

  const parseCommandInvocation = (value: string) => {
    const trimmed = value.trim();
    const match = trimmed.match(/^\/([a-zA-Z0-9-]+(?::[a-zA-Z0-9-]+)?)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    const token = match[1];
    const [namespace, name] = token.includes(':') ? token.split(':', 2) : [null, token];
    return {
      name,
      namespace,
      token,
      args: match[2] || '',
    };
  };

  const getCommandInvocation = (command: SlashCommand) =>
    command.namespace ? `/${command.namespace}:${command.name}` : `/${command.name}`;

  const getCommandScopeLabel = (command: SlashCommand) => {
    if (command.type === 'builtin') {
      return 'builtin';
    }
    if (command.scope === 'project') {
      return command.namespace ? `project:${command.namespace}` : 'project';
    }
    if (command.scope === 'user') {
      return 'user';
    }
    return 'custom';
  };

  const buildHelpMessage = () => {
    const projectCommands = slashCommands.filter(
      (command) => command.type === 'custom' && command.scope === 'project'
    );
    const userCommands = slashCommands.filter(
      (command) => command.type === 'custom' && command.scope === 'user'
    );
    const builtInCommands = slashCommands.filter((command) => command.type === 'builtin');

    const formatLine = (command: SlashCommand) => {
      const hint = command.argumentHint ? ` ${command.argumentHint}` : '';
      const description = command.description ? ` — ${command.description}` : '';
      const scope = getCommandScopeLabel(command);
      const supportSuffix =
        command.type === 'builtin' && !command.supported
          ? ' (not supported here)'
          : '';
      return `- \`${getCommandInvocation(command)}${hint}\`${description} (${scope})${supportSuffix}`;
    };

    const sections = [
      'Available slash commands:',
      '',
      projectCommands.length ? 'Project commands:' : null,
      ...projectCommands.map(formatLine),
      projectCommands.length ? '' : null,
      userCommands.length ? 'Personal commands:' : null,
      ...userCommands.map(formatLine),
      userCommands.length ? '' : null,
      builtInCommands.length ? 'Built-in commands:' : null,
      ...builtInCommands.map(formatLine),
    ].filter((line) => line !== null);

    return sections.join('\n');
  };

  const buildUiEditDraft = (selection: UiSelection): UiEditDraft => {
    // For select elements, use selection.text (the selected option's display text)
    const isSelect = selection.tagName?.toLowerCase() === 'select';
    const textValue = isSelect ? (selection.text ?? '') : (selection.editableText ?? '');

    return {
      text: textValue,
      placeholder: selection.placeholder ?? '',
      value: selection.value ?? '',
      styles: {
        color: selection.computedStyles?.color || '',
        backgroundColor: selection.computedStyles?.backgroundColor || '',
        fontSize: selection.computedStyles?.fontSize || '',
        fontWeight: selection.computedStyles?.fontWeight || '',
        lineHeight: selection.computedStyles?.lineHeight || '',
        textAlign: selection.computedStyles?.textAlign || '',
        padding: selection.computedStyles?.padding || '',
        margin: selection.computedStyles?.margin || '',
        borderRadius: selection.computedStyles?.borderRadius || '',
      },
    };
  };

  const getUiEditsPayload = (): UiEditPayload | null => {
    if (!uiSelection || !uiEditDraft || !uiEditInitial) return null;
    const payload: UiEditPayload = {};

    const canEditText =
      uiSelection.elementType === 'text' ||
      uiSelection.elementType === 'other' ||
      Boolean(uiSelection.editableText);
    const canEditValue =
      uiSelection.elementType === 'input' || uiSelection.elementType === 'textarea';

    if (canEditText && uiEditDraft.text !== uiEditInitial.text) {
      payload.text = uiEditDraft.text;
    }
    if (canEditValue && uiEditDraft.value !== uiEditInitial.value) {
      payload.value = uiEditDraft.value;
    }
    if (canEditValue && uiEditDraft.placeholder !== uiEditInitial.placeholder) {
      payload.placeholder = uiEditDraft.placeholder;
    }

    const styleChanges: Record<string, string> = {};
    for (const key of Object.keys(uiEditDraft.styles)) {
      if (uiEditDraft.styles[key] !== uiEditInitial.styles[key]) {
        styleChanges[key] = uiEditDraft.styles[key];
      }
    }
    if (Object.keys(styleChanges).length > 0) {
      payload.styles = styleChanges;
    }

    return Object.keys(payload).length > 0 ? payload : null;
  };

  const buildUiEditSummary = (payload: UiEditPayload, selection: UiSelection) => {
    const fields: string[] = [];
    if (payload.text !== undefined) fields.push('text');
    if (payload.value !== undefined) fields.push('value');
    if (payload.placeholder !== undefined) fields.push('placeholder');
    if (payload.styles) {
      const styleLabels = STYLE_FIELDS.reduce<Record<string, string>>((acc, field) => {
        acc[field.key] = field.label.toLowerCase();
        return acc;
      }, {});
      Object.keys(payload.styles).forEach((key) => {
        fields.push(styleLabels[key] || key);
      });
    }

    const label = getSelectionLabel(selection);
    if (fields.length === 0) {
      return `Local edits saved (${label}).`;
    }
    return `Local edits saved (${label}): ${fields.join(', ')}.`;
  };

  const sortObject = (value: Record<string, string>) => {
    const sorted: Record<string, string> = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        sorted[key] = value[key];
      });
    return sorted;
  };

  const serializeEdits = (payload: UiEditPayload | null) => {
    if (!payload) return '';
    const normalized: UiEditPayload = {
      text: payload.text,
      placeholder: payload.placeholder,
      value: payload.value,
      styles: payload.styles ? sortObject(payload.styles as Record<string, string>) : undefined,
    };
    return JSON.stringify(normalized);
  };

  const updateCommandMatches = (value: string, cursor: number | null) => {
    if (cursor === null || cursor === undefined) {
      setCommandMatches([]);
      setCommandAnchor(null);
      return;
    }

    const beforeCursor = value.slice(0, cursor);
    const slashIndex = beforeCursor.lastIndexOf('/');
    if (slashIndex === -1) {
      setCommandMatches([]);
      setCommandAnchor(null);
      return;
    }

    const charBeforeSlash = slashIndex > 0 ? beforeCursor[slashIndex - 1] : ' ';
    if (charBeforeSlash && !/\s/.test(charBeforeSlash)) {
      setCommandMatches([]);
      setCommandAnchor(null);
      return;
    }

    const commandQuery = beforeCursor.slice(slashIndex + 1);
    if (/\s/.test(commandQuery)) {
      setCommandMatches([]);
      setCommandAnchor(null);
      return;
    }

    const query = commandQuery.toLowerCase();
    const filtered = slashCommands
      .filter((command) => {
        const fullName = getCommandInvocation(command).slice(1).toLowerCase();
        if (fullName.startsWith(query)) return true;
        if (!query.includes(':') && command.name.toLowerCase().startsWith(query)) return true;
        return false;
      })
      .slice(0, 8);

    if (filtered.length === 0) {
      setCommandMatches([]);
      setCommandAnchor(null);
      return;
    }

    setCommandMatches(filtered);
    setCommandAnchor({ start: slashIndex, end: cursor });
    setCommandIndex(0);
  };

  const applySlashCommand = (command: SlashCommand) => {
    if (!commandAnchor) return;
    const before = input.slice(0, commandAnchor.start);
    const after = input.slice(commandAnchor.end);
    const needsSpace = after.length === 0 || (!after.startsWith(' ') && !after.startsWith('\n'));
    const insertion = `${getCommandInvocation(command)}${needsSpace ? ' ' : ''}`;
    const nextValue = `${before}${insertion}${after}`;
    setInput(nextValue);
    setCommandMatches([]);
    setCommandAnchor(null);

    requestAnimationFrame(() => {
      if (inputRef.current) {
        const cursor = (before + insertion).length;
        inputRef.current.focus();
        inputRef.current.setSelectionRange(cursor, cursor);
      }
    });
  };

  // Load chat history from database
  const loadHistory = async () => {
    try {
      setIsLoadingHistory(true);
      setHasMoreHistory(false);
      setHistoryOffset(0);
      const response = await axios.get(`${getApiBaseUrl()}/chat/sessions/${projectId}/history`, {
        params: { limit: PAGE_SIZE, latest: true },
      });

      const rawMessages = response.data.messages || [];
      const offset = Number(response.data.offset) || 0;
      const historyMessages = formatHistoryMessages(rawMessages);

      if (response.data.success && historyMessages.length > 0) {
        console.log('Loaded messages:', historyMessages.map(m => ({
          id: m.id,
          role: m.role,
          isToolUse: m.isToolUse,
          toolName: m.toolName
        })));
        setMessages(historyMessages);
        setHistoryOffset(offset);
        setHasMoreHistory(offset > 0);
        flushPendingRecovery();
      } else {
        // No history, show welcome message
        setMessages([
          {
            id: 'welcome',
            role: 'system',
            content: 'Agent connected. What would you like to build?',
            timestamp: new Date(),
          },
        ]);
        setHistoryOffset(0);
        setHasMoreHistory(false);
        flushPendingRecovery();
      }
    } catch (error) {
      console.error('Failed to load chat history:', error);
      // Show welcome message on error
      setMessages([
        {
          id: 'welcome',
          role: 'system',
          content: 'Agent connected. What would you like to build?',
          timestamp: new Date(),
        },
      ]);
      setHistoryOffset(0);
      setHasMoreHistory(false);
      flushPendingRecovery();
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const mergeHistoryMessages = useCallback((incomingMessages: Message[]) => {
    if (!incomingMessages.length) return;

    const getMessageKey = (msg: Message) => {
      if (msg.isToolUse && msg.toolId) return `tool:${msg.toolId}`;
      return `msg:${msg.id}`;
    };

    setMessages((prev) => {
      const merged = new Map<string, Message>();
      for (const msg of prev) {
        if (msg.id === 'welcome' && incomingMessages.length > 0) continue;
        merged.set(getMessageKey(msg), msg);
      }
      for (const msg of incomingMessages) {
        merged.set(getMessageKey(msg), msg);
      }
      return Array.from(merged.values()).sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
      );
    });
  }, []);

  const refreshActiveHistory = useCallback(async () => {
    try {
      const response = await axios.get(`${getApiBaseUrl()}/chat/sessions/${projectId}/history`, {
        params: { limit: PAGE_SIZE, latest: true },
      });
      const rawMessages = response.data.messages || [];
      mergeHistoryMessages(formatHistoryMessages(rawMessages));
    } catch (error) {
      console.error('Failed to refresh active chat history:', error);
    }
  }, [mergeHistoryMessages, projectId]);

  const applyRecovery = (recovery: { content: string; startedAt?: string }) => {
    if (recovery.content) {
      setMessages((prev) => {
        const updated = [...prev];
        const lastMessage = updated[updated.length - 1];
        const recoveryStartedAt = recovery.startedAt ? new Date(recovery.startedAt).getTime() : null;
        const lastMessageTime = lastMessage?.timestamp ? new Date(lastMessage.timestamp).getTime() : null;
        const canUpdateExisting =
          lastMessage &&
          lastMessage.role === 'assistant' &&
          !lastMessage.isToolUse &&
          (lastMessage.isStreaming ||
            (recoveryStartedAt !== null &&
              lastMessageTime !== null &&
              lastMessageTime >= recoveryStartedAt - 1000) ||
            (lastMessage.content && recovery.content.startsWith(lastMessage.content)));

        if (canUpdateExisting) {
          lastMessage.content = recovery.content;
          lastMessage.isStreaming = true;
        } else {
          updated.push({
            id: generateId(),
            role: 'assistant',
            content: recovery.content,
            timestamp: recovery.startedAt ? new Date(recovery.startedAt) : new Date(),
            isStreaming: true,
          });
        }

        return updated;
      });
    }

    setIsProcessing(true);
    setIsTyping(true);
    setCurrentActivity('Resuming response...');
    isRecoveryProcessingRef.current = true;
  };

  const flushPendingRecovery = () => {
    if (pendingRecoveryRef.current) {
      applyRecovery(pendingRecoveryRef.current);
      pendingRecoveryRef.current = null;
    }
  };

  useEffect(() => {
    isLoadingHistoryRef.current = isLoadingHistory;
  }, [isLoadingHistory]);

  // Add pending screenshot file to selected files
  useEffect(() => {
    if (pendingScreenshotFile) {
      setSelectedFiles((prev) => {
        const next = prev.filter((file) => !file.name.startsWith('atlas-screenshot-'));
        next.push(pendingScreenshotFile);
        return next;
      });
      onScreenshotFileConsumed?.();
    }
  }, [pendingScreenshotFile, onScreenshotFileConsumed]);

  // Close select menu on click outside
  useEffect(() => {
    if (!showSelectMenu) return;
    const handler = (e: MouseEvent) => {
      if (selectMenuRef.current && !selectMenuRef.current.contains(e.target as Node)) {
        setShowSelectMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSelectMenu]);

  // Listen for "Ask AI to fix" messages from other panels (e.g. PublishPanel)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.message) {
        setInput(detail.message);
        // Auto-focus the textarea
        inputRef.current?.focus();
      }
    };
    window.addEventListener('atlas-send-chat-message', handler);
    return () => window.removeEventListener('atlas-send-chat-message', handler);
  }, []);

  // Reset initialPromptSentRef when projectId changes so a new project can auto-send
  useEffect(() => {
    initialPromptSentRef.current = false;
  }, [projectId]);

  useEffect(() => {
    if (!initialPromptRequestId || initialPromptSentRef.current) {
      return;
    }

    const alreadyLoaded = messages.some((msg) => (
      msg.role === 'user' && msg.clientRequestId === initialPromptRequestId
    ));
    if (!alreadyLoaded) {
      return;
    }

    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.();
  }, [initialPromptRequestId, messages, onInitialPromptConsumed]);

  // Auto-send the initial prompt from the Build HomePage once socket is ready and history is loaded.
  // Schedule on the next macrotask so React.StrictMode's throwaway mount in browser dev
  // cancels the send during cleanup. The real mount keeps the timer and performs the send.
  useEffect(() => {
    if (!initialPrompt || initialPromptSentRef.current || !isConnected || isLoadingHistory || !socketRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      initialPromptSentRef.current = true;
      void dispatchMessage(initialPrompt, {
        attachmentFiles: initialFiles,
        modeOverride: initialPromptMode,
        providerOverride: initialPromptProviderType,
        modelAliasOverride: initialPromptModelAlias,
        clientRequestId: initialPromptRequestId,
      });
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [initialPrompt, initialFiles, initialPromptMode, initialPromptProviderType, initialPromptModelAlias, initialPromptRequestId, isConnected, isLoadingHistory]);

  // Display external system messages (local-only, not sent to LLM)
  useEffect(() => {
    if (pendingSystemMessage) {
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: 'system' as const,
          content: pendingSystemMessage.content,
          timestamp: new Date(),
          tone: pendingSystemMessage.tone as Message['tone'],
        },
      ]);
      onSystemMessageConsumed?.();
    }
  }, [pendingSystemMessage, onSystemMessageConsumed]);

  useEffect(() => {
    isLoadingMoreRef.current = isLoadingMore;
  }, [isLoadingMore]);

  useEffect(() => {
    chatModeRef.current = chatMode;
  }, [chatMode]);

  useEffect(() => {
    onFileChangeRef.current = onFileChange;
  }, [onFileChange]);

  useEffect(() => {
    onFileTreeChangeRef.current = onFileTreeChange;
  }, [onFileTreeChange]);

  useEffect(() => {
    isProcessingRef.current = isProcessing;
    currentActivityRef.current = currentActivity;
  }, [currentActivity, isProcessing]);

  useEffect(() => {
    hasConversationStateRef.current = messages.some((msg) => (
      msg.isToolUse
      || msg.role === 'assistant'
      || (msg.role === 'system' && msg.id !== 'welcome' && Boolean(msg.content?.trim()))
    ));
  }, [messages]);

  useEffect(() => {
    if (!isProcessing || !isRecoveryProcessingRef.current) {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      if (!cancelled) {
        void refreshActiveHistory();
      }
    }, 2000);

    void refreshActiveHistory();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isProcessing, refreshActiveHistory]);

  useEffect(() => {
    if (!isProcessing || currentActivity !== 'Resuming response...') {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const runtimeStatus = await chatApi.getRuntimeStatus(projectId);
          if (cancelled || shouldApplyChatRecovery({ content: '' }, runtimeStatus)) {
            return;
          }

          console.log('[ChatPanel] Clearing stale recovery state for idle project', projectId);
          setIsTyping(false);
          setIsProcessing(false);
          setCurrentActivity('');
          isRecoveryProcessingRef.current = false;
        } catch (error) {
          if (!cancelled) {
            console.warn('[ChatPanel] Failed to re-check recovery runtime status', error);
          }
        }
      })();
    }, 2500);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [currentActivity, isProcessing, projectId]);

  useEffect(() => {
    if (isLoadingHistory || isProcessing) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const runtimeStatus = await chatApi.getRuntimeStatus(projectId);
        if (cancelled || !shouldApplyChatRecovery({ content: '' }, runtimeStatus)) {
          return;
        }

        console.log('[ChatPanel] Restoring active runtime state from backend status', projectId, runtimeStatus);
        applyRecovery({
          content: '',
          startedAt: runtimeStatus.startedAt || runtimeStatus.streamStartedAt || undefined,
        });
      } catch (error) {
        if (!cancelled) {
          console.warn('[ChatPanel] Failed to restore runtime state after history load', error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoadingHistory, isProcessing, projectId]);

  useEffect(() => {
    return () => {
      pendingFileRefreshTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      pendingFileRefreshTimeoutsRef.current = [];
      if (pendingFileTreeRefreshTimeoutRef.current != null) {
        window.clearTimeout(pendingFileTreeRefreshTimeoutRef.current);
        pendingFileTreeRefreshTimeoutRef.current = null;
      }
    };
  }, []);

  const triggerPreviewRefreshPulse = useCallback((reason: string) => {
    if (pendingFileRefreshTimeoutsRef.current.length > 0) {
      pendingFileRefreshTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      pendingFileRefreshTimeoutsRef.current = [];
    }

    // During an active AI run, just mark that file changes occurred.
    // The preview will refresh once when the run completes, avoiding
    // premature renders of half-built projects.
    if (isProcessingRef.current) {
      console.log(`[ChatPanel] Deferring preview refresh during AI run (${reason})`);
      fileOperationsOccurredRef.current = true;
      return;
    }

    console.log(`[ChatPanel] Triggering preview refresh (${reason})`);
    const timeoutId = window.setTimeout(() => {
      onFileChangeRef.current?.();
      pendingFileRefreshTimeoutsRef.current = [];
    }, 300);
    pendingFileRefreshTimeoutsRef.current = [timeoutId];
  }, []);

  const triggerFileTreeRefresh = useCallback((reason: string) => {
    if (pendingFileTreeRefreshTimeoutRef.current != null) {
      window.clearTimeout(pendingFileTreeRefreshTimeoutRef.current);
    }

    console.log(`[ChatPanel] Scheduling file tree refresh (${reason})`);
    pendingFileTreeRefreshTimeoutRef.current = window.setTimeout(() => {
      onFileTreeChangeRef.current?.();
      pendingFileTreeRefreshTimeoutRef.current = null;
    }, 150);
  }, []);

  useEffect(() => {
    if (chatMode !== 'plan') {
      setShowPlanActions(false);
    }
  }, [chatMode]);

  useEffect(() => {
    let isActive = true;

    const loadSlashCommands = async () => {
      try {
        const response = await chatApi.getSlashCommands(projectId);
        if (!isActive) return;
        if (response.success) {
          setSlashCommands(response.commands as SlashCommand[]);
        } else {
          setSlashCommands([]);
        }
      } catch (error) {
        console.error('Failed to load slash commands:', error);
        if (isActive) {
          setSlashCommands([]);
        }
      }
    };

    if (projectId) {
      loadSlashCommands();
    } else {
      setSlashCommands([]);
    }

    return () => {
      isActive = false;
    };
  }, [projectId, onProjectRenamed]);

  useEffect(() => {
    updateCommandMatches(input, inputRef.current?.selectionStart ?? null);
  }, [slashCommands]);

  useEffect(() => {
    if (uiSelection) {
      const nextDraft = buildUiEditDraft(uiSelection);
      setUiEditDraft(nextDraft);
      setUiEditInitial(nextDraft);
      setUiEditSavedPayload(null);
      setIsLocalEditorOpen(true);
    } else {
      setUiEditDraft(null);
      setUiEditInitial(null);
      setUiEditSavedPayload(null);
      setIsLocalEditorOpen(false);
    }
  }, [uiSelection]);

  useEffect(() => {
    // Initialize Socket.IO connection
    // Extract base URL without /api path for WebSocket connection
    const wsUrl = getApiBaseUrl().replace(/\/api$/, '');

    const socket = io(wsUrl, {
      transports: ['websocket'],
      auth: getSocketAuth(),
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      socket.emit('join-project', projectId);
      socket.emit('ai-check-auth', {});

      // Load chat history from database
      loadHistory();
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    // Handle AI typing indicator
    socket.on('ai-typing', () => {
      setIsTyping(true);
      setIsProcessing(true);
      setCurrentActivity('Processing your request...');
    });

    // Handle streaming events from Claude CLI
    socket.on('claude-stream-event', (data: { type: string; data: any }) => {
      // Keep typing indicator visible while processing
      // Don't set isTyping to false here - let it stay until completion

      if (data.type === 'text') {
        // Stream text content through markdown buffer to prevent flicker
        const safeText = mdBufferRef.current.append(data.data.text);
        if (!safeText && data.data.text) {
          // Chunk was buffered (incomplete construct) — skip this update
          return;
        }
        if (safeText && safeText.trim()) {
          requestSawAssistantTextRef.current = true;
        }
        setCurrentActivity('Writing response...');
        setMessages((prev) => {
          const updated = [...prev];
          const lastMessage = updated[updated.length - 1];

          if (lastMessage && lastMessage.role === 'assistant' && lastMessage.isStreaming && !lastMessage.isToolUse) {
            // Append to existing streaming message
            lastMessage.content += safeText;
          } else {
            // Create new streaming message with current mode
            updated.push({
              id: generateId(),
              role: 'assistant',
              content: safeText,
              timestamp: new Date(),
              isStreaming: true,
              mode: chatModeRef.current,  // Capture mode when message starts
            });
          }
          return updated;
        });
      } else if (data.type === 'tool_use') {
        // Tool use event - create a tool message
        setCurrentActivity(`Using ${data.data.name}...`);
        requestToolUseCountRef.current += 1;
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: 'assistant',
            content: '',
            timestamp: new Date(),
            isToolUse: true,
            toolName: data.data.name,
            toolInput: data.data.input,
            toolId: data.data.id,
          },
        ]);

        // Track file operations with provider-agnostic heuristics.
        const toolInput = data.data.input;
        if (isLikelyMutatingTool(data.data.name, toolInput)) {
          fileOperationsOccurredRef.current = true;
          const paths = collectFilePathsFromToolInput(toolInput);
          paths.forEach((filePath) => requestChangedFilesRef.current.add(filePath));
          triggerPreviewRefreshPulse(`tool use: ${data.data.name}`);
          if (shouldTriggerFileTreeRefreshFromToolUse(data.data.name, toolInput, paths)) {
            triggerFileTreeRefresh(`tool use: ${data.data.name}`);
          }
        }
      } else if (data.type === 'file_diff') {
        // File diff event - attach diff to the corresponding tool_use message
        console.log('📊 Received file diff for:', data.data.filePath);
        fileOperationsOccurredRef.current = true;
        if (data.data.filePath) {
          requestChangedFilesRef.current.add(String(data.data.filePath));
        }
        triggerPreviewRefreshPulse(`file diff: ${data.data.filePath || 'unknown'}`);
        if (data.data.isNewFile) {
          triggerFileTreeRefresh(`new file: ${data.data.filePath || 'unknown'}`);
        }
        setMessages((prev) => {
          return prev.map((msg) => {
            if (msg.toolId === data.data.toolCallId) {
              return {
                ...msg,
                fileDiff: {
                  filePath: data.data.filePath,
                  beforeContent: data.data.beforeContent,
                  afterContent: data.data.afterContent,
                  isNewFile: data.data.isNewFile,
                  language: data.data.language,
                  stats: data.data.stats,
                },
              };
            }
            return msg;
          });
        });
      } else if (data.type === 'changeset_created') {
        // Changeset created - dispatch window event for ChangeSetsPanel to refresh
        console.log('📋 Changeset created:', data.data.id, data.data.title);
        fileOperationsOccurredRef.current = true;
        triggerPreviewRefreshPulse(`changeset: ${data.data.id}`);
        requestChangesetRef.current = {
          id: data.data.id,
          title: data.data.title,
          fileCount: data.data.fileCount,
          filePaths: Array.isArray(data.data.filePaths) ? data.data.filePaths : undefined,
        };
        if (Array.isArray(data.data.filePaths)) {
          data.data.filePaths.forEach((filePath: string) => {
            if (filePath) {
              requestChangedFilesRef.current.add(filePath);
            }
          });
        }
        window.dispatchEvent(new CustomEvent('atlas-changeset-created', {
          detail: data.data,
        }));
      }
    });

    // Handle completion
    socket.on('claude-complete', (data?: { sessionMessageCount?: number; buildSummary?: { filesChanged: number; filePaths: string[]; newFiles: string[]; modifiedFiles: string[]; changesetId: string | null; changesetTitle: string | null } }) => {
      setIsTyping(false);
      setIsProcessing(false);
      setCurrentActivity('');
      isRecoveryProcessingRef.current = false;
      if (data?.sessionMessageCount != null) {
        setSessionMessageCount(data.sessionMessageCount);
      }
      const shouldShowPlanActions =
        lastRequestModeRef.current === 'plan' && chatModeRef.current === 'plan';
      setShowPlanActions(shouldShowPlanActions);

      // Flush any remaining markdown buffer content
      const remaining = mdBufferRef.current.flush();

      // Mark ALL streaming messages as complete (not just the last one)
      // Multiple assistant messages can be streaming if tool uses interrupted text flow
      // Only append remaining buffer to the LAST streaming text message (it owns the buffer)
      setMessages((prev) => {
        let lastStreamIdx = -1;
        if (remaining) {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === 'assistant' && prev[i].isStreaming && !prev[i].isToolUse) {
              lastStreamIdx = i;
              break;
            }
          }
        }
        return prev.map((msg, i) => {
          if (msg.role === 'assistant' && msg.isStreaming) {
            const finalContent = i === lastStreamIdx ? msg.content + remaining : msg.content;
            return { ...msg, content: finalContent, isStreaming: false };
          }
          return msg;
        });
      });

      const changedFiles = Array.from(requestChangedFilesRef.current).filter(Boolean);
      const changeset = requestChangesetRef.current;
      const backendBuildSummary = data?.buildSummary;
      const hasDetectedFileChanges =
        fileOperationsOccurredRef.current
        || changedFiles.length > 0
        || Boolean(changeset)
        || Boolean(backendBuildSummary?.filesChanged && backendBuildSummary.filesChanged > 0);
      const isBuildRequest = lastRequestModeRef.current === 'build';

      // Fire a single preview refresh now that the AI run is complete.
      // All mid-run file changes were deferred — this is the one refresh.
      if (hasDetectedFileChanges) {
        console.log('AI run complete — triggering single preview refresh');
        // Clear any pending deferred refreshes and fire immediately
        if (pendingFileRefreshTimeoutsRef.current.length > 0) {
          pendingFileRefreshTimeoutsRef.current.forEach((id) => window.clearTimeout(id));
          pendingFileRefreshTimeoutsRef.current = [];
        }
        const refreshId = window.setTimeout(() => {
          onFileChangeRef.current?.();
          pendingFileRefreshTimeoutsRef.current = [];
        }, 300);
        pendingFileRefreshTimeoutsRef.current = [refreshId];
        if (isBuildRequest) {
          window.dispatchEvent(new CustomEvent('atlas-navigate-to-preview'));
        }
      }

      if ((backendBuildSummary?.newFiles?.length || 0) > 0) {
        triggerFileTreeRefresh('request complete new files');
      }

      if (isBuildRequest && hasDetectedFileChanges) {
        // Use backend buildSummary if available, fall back to local data
        const bs = backendBuildSummary;
        let summary: string;
        if (bs && bs.filesChanged > 0) {
          summary = buildCompletionSummary(bs);
        } else {
          const localFilePaths = Array.from(new Set([
            ...(Array.isArray(changeset?.filePaths) ? changeset.filePaths : []),
            ...changedFiles,
          ])).filter(Boolean);

          if (localFilePaths.length > 0) {
            summary = buildCompletionSummary({
              filesChanged: localFilePaths.length,
              filePaths: localFilePaths,
              newFiles: [],
              modifiedFiles: localFilePaths,
              changesetId: changeset?.id || null,
              changesetTitle: changeset?.title || null,
            });
          } else {
            const countFromChangeset = typeof changeset?.fileCount === 'number' ? changeset.fileCount : null;
            const totalFilesChanged = countFromChangeset ?? changedFiles.length;
            summary = `**Build Complete** — Updated ${totalFilesChanged} file${totalFilesChanged === 1 ? '' : 's'}.`;
          }
        }
        pushSystemMessage(summary, 'success');
        // Persist build summary (fire-and-forget)
        chatApi.saveSystemMessage(projectId, { content: summary, tone: 'success' }).catch(() => {});
      } else if (
        isBuildRequest &&
        !requestSawAssistantTextRef.current &&
        requestToolUseCountRef.current > 0
      ) {
        pushSystemMessage(
          'Build run finished, but no file changes were detected. Ask for a short summary and explicit edits if you expected code updates.',
          'warning'
        );
      }

      fileOperationsOccurredRef.current = false;
    });

    // Keep old ai-response handler for backward compatibility
    socket.on('ai-response', (data: { message: string }) => {
      setIsTyping(false);
      setIsProcessing(false);
      setCurrentActivity('');
      isRecoveryProcessingRef.current = false;
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: 'assistant',
          content: data.message,
          timestamp: new Date(),
        },
      ]);
    });

    // Handle errors
    socket.on('ai-error', (data: { error: string }) => {
      setIsTyping(false);
      setIsProcessing(false);
      setCurrentActivity('');
      isRecoveryProcessingRef.current = false;
      setShowPlanActions(false);
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: 'system',
          content: `Error: ${data.error}`,
          timestamp: new Date(),
        },
      ]);
    });

    socket.on('ai-stopped', (data: { projectId: string }) => {
      if (data.projectId !== projectId) return;

      setIsTyping(false);
      setIsProcessing(false);
      setCurrentActivity('');
      isRecoveryProcessingRef.current = false;
      setShowPlanActions(false);
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: 'system',
          content: 'Request stopped',
          timestamp: new Date(),
        },
      ]);
    });

    socket.on('ai-auth-status', (data: { authenticated: boolean; error?: string; checking?: boolean; provider?: string }) => {
      console.log('[ChatPanel] Received auth status:', data);
      setAuthStatus(data);
    });

    socket.on('project-updated', (data: { projectId?: string; name?: string }) => {
      if (data?.projectId !== projectId || !data?.name) return;
      onProjectRenamed?.(data.projectId, data.name);
    });

    socket.on('ai-chat-recovery', (data: { projectId: string; content: string; startedAt?: string }) => {
      if (data.projectId !== projectId) return;
      const recovery = { content: data.content, startedAt: data.startedAt };

      void (async () => {
        if (
          !recovery.content?.trim()
          && initialPromptRequestId
          && !hasConversationStateRef.current
        ) {
          console.log(
            '[ChatPanel] Ignoring empty recovery payload during initial home prompt handoff',
            projectId,
            initialPromptRequestId,
          );
          return;
        }

        if (!recovery.content?.trim() && isProcessingRef.current) {
          console.log(
            '[ChatPanel] Ignoring empty recovery payload because local request is already in progress',
            projectId,
            currentActivityRef.current,
          );
          return;
        }

        if (!recovery.content?.trim()) {
          try {
            const runtimeStatus = await chatApi.getRuntimeStatus(projectId);
            if (!shouldApplyChatRecovery(recovery, runtimeStatus)) {
              console.log('[ChatPanel] Ignoring stale empty recovery payload for idle project', projectId);
              return;
            }
          } catch (error) {
            console.warn('[ChatPanel] Failed to verify recovery runtime status, applying recovery defensively', error);
          }
        }

        if (isLoadingHistoryRef.current) {
          pendingRecoveryRef.current = recovery;
        } else {
          applyRecovery(recovery);
        }
      })();
    });

    // Plan UI events intentionally omitted in simplified plan flow.

    return () => {
      socket.disconnect();
    };
  }, [projectId]);

  // Helper to safely access localStorage
  const safeGetStorage = (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const safeSetStorage = (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Silently fail if storage is blocked
    }
  };

  // Fetch available CLI adapters on mount
  useEffect(() => {
    const fetchCLIs = async () => {
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
          const supportedAdapters = response.adapters.filter((adapter: CLIAdapter) => adapter.supported);
          setAvailableCLIs(supportedAdapters);

          const modelOptions: BuildModelOption[] = supportedAdapters.flatMap((adapter: CLIAdapter) => {
            // Skip OpenCode's static placeholder — we'll replace with dynamic models below
            if (adapter.type === 'opencode') return [];
            const adapterModels = adapter.models || [];
            return adapterModels.map((model) => ({
              key: `${adapter.type}:${model.alias}`,
              providerType: adapter.type,
              providerName: adapter.name,
              alias: model.alias,
              name: model.name,
              description: model.description || '',
              isDefault: Boolean(adapter.defaultModel && adapter.defaultModel === model.alias),
            }));
          });

          // Fetch dynamic OpenCode models (tool-capable only) if OpenCode adapter is available
          const hasOpenCode = supportedAdapters.some((a: CLIAdapter) => a.type === 'opencode');
          if (hasOpenCode) {
            try {
              const ocResult = await providerApi.getOpenCodeModels();
              if (ocResult.models?.length) {
                for (const m of ocResult.models) {
                  modelOptions.push({
                    key: `opencode:${m.id}`,
                    providerType: 'opencode',
                    providerName: 'OpenCode',
                    alias: m.id,
                    name: m.label,
                    description: '',
                    isDefault: m.id === ocResult.activeModel,
                  });
                }
              } else {
                // Fallback if no models configured
                modelOptions.push({
                  key: 'opencode:opencode-default',
                  providerType: 'opencode',
                  providerName: 'OpenCode',
                  alias: 'opencode-default',
                  name: 'OpenCode Default',
                  description: '',
                  isDefault: true,
                });
              }
            } catch {
              // Fallback on error
              modelOptions.push({
                key: 'opencode:opencode-default',
                providerType: 'opencode',
                providerName: 'OpenCode',
                alias: 'opencode-default',
                name: 'OpenCode Default',
                description: '',
                isDefault: true,
              });
            }
          }

          setAvailableModels(modelOptions);
          console.log('[ChatPanel] Loaded model options:', modelOptions);
        } else {
          setAvailableCLIs([]);
          setAvailableModels([]);
        }
      } catch (error) {
        console.error('[ChatPanel] Failed to load CLI adapters:', error);
        setAvailableCLIs([]);
        setAvailableModels([]);
      } finally {
        setIsLoadingModels(false);
      }
    };
    fetchCLIs();
  }, []);

  useEffect(() => {
    const refreshBuildProviderPreferences = async () => {
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

    const handleProviderChanged = () => { void refreshBuildProviderPreferences(); };
    window.addEventListener('provider-changed', handleProviderChanged);
    window.addEventListener('build-provider-changed', handleProviderChanged);
    return () => {
      window.removeEventListener('provider-changed', handleProviderChanged);
      window.removeEventListener('build-provider-changed', handleProviderChanged);
    };
  }, []);

  // Ensure selected model is valid and defaults to the user's CLI preference.
  useEffect(() => {
    if (availableModels.length === 0) {
      setSelectedModel('');
      return;
    }

    const hasModel = (key: string | null | undefined) =>
      Boolean(key) && availableModels.some((model) => model.key === key);
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

    if (hasModel(selectedModel) && isConnectedModel(selectedModel)) {
      return;
    }

    const preferredKey = pickPreferredBuildModelKey(availableModels, connectedProviders, {
      contextActive: buildContextActive,
      storedCombined: safeGetStorage('atlas_selected_cli_model'),
      storedProvider: safeGetStorage('atlas_selected_cli'),
      authProvider: authStatus?.provider || null,
    });
    if (preferredKey) {
      setSelectedModel(preferredKey);
      return;
    }

    const fallback = availableModels.find((model) => model.isDefault) || availableModels[0];
    setSelectedModel(fallback.key);
  }, [availableModels, authStatus?.provider, buildContextActive, connectedProviders, selectedModel]);

  // Persist model/provider selection to localStorage.
  useEffect(() => {
    if (selectedModelOption) {
      safeSetStorage('atlas_selected_cli_model', selectedModelOption.key);
      safeSetStorage('atlas_selected_model', selectedModelOption.alias);
      safeSetStorage('atlas_selected_cli', selectedModelOption.providerType);
    }
  }, [selectedModelOption]);

  // Persist chat mode to localStorage (loaded via lazy initialization above)
  useEffect(() => {
    safeSetStorage('atlas_chat_mode', chatMode);
  }, [chatMode]);

  // Global keyboard shortcut for toggling chat mode (Cmd/Ctrl+Shift+P)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + Shift + P cycles through chat modes: agent -> plan -> build -> agent
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        e.stopPropagation();
        setChatMode(prev => {
          const next = prev === 'agent' ? 'plan' : prev === 'plan' ? 'build' : 'agent';
          chatModeRef.current = next;
          return next;
        });
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // Calculate dropdown width based on selected model text
  useEffect(() => {
    const displayName = selectedModelOption
      ? `${selectedModelOption.name}${selectedModelOption.isDefault ? ' (Default)' : ''}`
      : 'Model';

    // Create a temporary span to measure text width
    const span = document.createElement('span');
    span.style.visibility = 'hidden';
    span.style.position = 'absolute';
    span.style.fontSize = '12px'; // text-xs
    span.style.fontFamily = 'inherit';
    span.style.whiteSpace = 'nowrap';
    span.textContent = displayName;
    document.body.appendChild(span);

    const textWidth = span.offsetWidth;
    document.body.removeChild(span);

    // Add padding for dropdown arrow and borders (approx 40px)
    setModelDropdownWidth(textWidth + 40);
  }, [selectedModelOption]);

  // Virtuoso handles auto-scroll via followOutput — this effect is the fallback
  // for the messagesEndRef anchor (used only when Virtuoso is not mounted)
  useEffect(() => {
    if (isLoadingMoreRef.current || suppressAutoScrollRef.current) {
      return;
    }
    // Virtuoso's followOutput handles auto-scroll; this is a safety net
    if (!virtuosoRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isTyping]);

  const loadOlderMessages = async () => {
    if (isLoadingMore || !hasMoreHistory) {
      return;
    }

    const container = messagesContainerRef.current;
    let anchorId: string | null = null;
    let anchorAttr: 'messageId' | 'turnAnchor' = 'messageId';
    let anchorTop = 0;
    if (container) {
      const containerTop = container.getBoundingClientRect().top;
      // Look for both message elements and turn containers as potential anchors
      const anchorEls = Array.from(
        container.querySelectorAll('[data-message-id], [data-turn-anchor]')
      ) as HTMLElement[];
      const anchorEl = anchorEls.find((el) => el.getBoundingClientRect().bottom > containerTop + 4);
      if (anchorEl) {
        // Prefer data-message-id, fall back to data-turn-anchor
        if (anchorEl.dataset.messageId) {
          anchorId = anchorEl.dataset.messageId;
          anchorAttr = 'messageId';
        } else if (anchorEl.dataset.turnAnchor) {
          anchorId = anchorEl.dataset.turnAnchor;
          anchorAttr = 'turnAnchor';
        }
        anchorTop = anchorEl.getBoundingClientRect().top;
      }
    }

    if (container) {
      container.style.scrollBehavior = 'auto';
    }

    suppressAutoScrollRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);

    try {
      const nextOffset = Math.max(historyOffset - PAGE_SIZE, 0);
      const limit = historyOffset - nextOffset || PAGE_SIZE;
      const response = await axios.get(`${getApiBaseUrl()}/chat/sessions/${projectId}/history`, {
        params: { limit, offset: nextOffset },
      });

      const rawMessages = response.data.messages || [];
      const olderMessages = formatHistoryMessages(rawMessages);
      if (olderMessages.length > 0) {
        // Compute new turn count to determine firstItemIndex delta for scroll stability
        const projectedMessages = [...olderMessages, ...messages];
        const newTurnCount = groupChatTimeline(projectedMessages).length;
        const delta = newTurnCount - groupedTurns.length;
        // Batch both updates — React renders them together, Virtuoso sees stable indices
        setVirtuosoFirstItemIndex(prev => prev - delta);
        setMessages(projectedMessages);
      }
      setHistoryOffset(nextOffset);
      setHasMoreHistory(nextOffset > 0);

      requestAnimationFrame(() => {
        if (container) {
          if (anchorId) {
            // Find anchor using the same attribute type that was used to find it
            const selector = anchorAttr === 'messageId'
              ? `[data-message-id="${anchorId}"]`
              : `[data-turn-anchor="${anchorId}"]`;
            const anchorEl = container.querySelector(selector) as HTMLElement | null;
            if (anchorEl) {
              const nextTop = anchorEl.getBoundingClientRect().top;
              container.scrollTop += nextTop - anchorTop;
            }
          }
          container.style.scrollBehavior = '';
        }
        setTimeout(() => {
          suppressAutoScrollRef.current = false;
          isLoadingMoreRef.current = false;
        }, 0);
      });
    } catch (error) {
      console.error('Failed to load older messages:', error);
      if (container) {
        container.style.scrollBehavior = '';
      }
      suppressAutoScrollRef.current = false;
      isLoadingMoreRef.current = false;
    } finally {
      setIsLoadingMore(false);
    }
  };

  const pushSystemMessage = (content: string, tone?: 'success' | 'error' | 'warning') => {
    setMessages((prev) => [
      ...prev,
      {
        id: generateId(),
        role: 'system',
        content,
        timestamp: new Date(),
        tone,
      },
    ]);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    updateCommandMatches(value, e.target.selectionStart);
  };

  const handleInputSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    // Skip arrow/escape key-ups so they don't reset commandIndex via updateCommandMatches
    if (e.nativeEvent instanceof KeyboardEvent) {
      const key = (e.nativeEvent as KeyboardEvent).key;
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Escape') return;
    }
    const target = e.currentTarget;
    updateCommandMatches(target.value, target.selectionStart);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (commandMatches.length > 0 && commandAnchor) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCommandIndex((prev) => (prev + 1) % commandMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCommandIndex((prev) => (prev - 1 + commandMatches.length) % commandMatches.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        applySlashCommand(commandMatches[commandIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setCommandMatches([]);
        setCommandAnchor(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const getSelectionLabel = (selection: UiSelection) => {
    const tagName = selection.tagName?.toLowerCase() || '';
    const role = (selection.attributes?.role || '').toLowerCase();
    const className = (selection.attributes?.class || '').toLowerCase();

    if (className.includes('card') || className.includes('panel')) return 'Card';
    if (tagName === 'button' || role === 'button') return 'Button';
    if (tagName === 'input') {
      const type = (selection.attributes?.type || '').toLowerCase();
      if (type === 'checkbox') return 'Checkbox';
      if (type === 'radio') return 'Radio';
      if (type === 'submit' || type === 'button') return 'Button';
      if (type === 'search') return 'Search input';
      return 'Input';
    }
    if (tagName === 'textarea') return 'Textarea';
    if (tagName === 'select') return 'Select';
    if (tagName === 'img') return 'Image';
    if (tagName === 'a') return 'Link';
    if (tagName === 'form') return 'Form';
    if (tagName === 'label') return 'Label';
    if (tagName === 'ul' || tagName === 'ol') return 'List';
    if (tagName === 'li') return 'List item';
    if (tagName === 'table') return 'Table';
    if (tagName === 'thead') return 'Table head';
    if (tagName === 'tbody') return 'Table body';
    if (tagName === 'tr') return 'Table row';
    if (tagName === 'td' || tagName === 'th') return 'Table cell';
    if (tagName === 'section') return 'Section';
    if (tagName === 'article') return 'Article';
    if (tagName === 'nav') return 'Nav';
    if (tagName === 'header') return 'Header';
    if (tagName === 'footer') return 'Footer';
    if (tagName === 'main') return 'Main';
    if (tagName === 'aside') return 'Aside';
    if (/^h[1-6]$/.test(tagName)) return 'Heading';
    if (tagName === 'p') return 'Paragraph';
    if (selection.elementType === 'text') return 'Text';
    if (tagName) return tagName.charAt(0).toUpperCase() + tagName.slice(1);
    return 'Element';
  };

  const handleUiEditReset = () => {
    if (!uiEditInitial) return;
    setUiEditDraft(uiEditInitial);
    onResetUiEdit?.();
  };

  const handleUiEditSave = async () => {
    const payload = getUiEditsPayload();
    if (!payload || !uiSelection) return false;

    setIsSavingEdits(true);
    try {
      const response = await uiEditsApi.save(projectId, uiSelection, payload);
      if (uiEditDraft) {
        setUiEditInitial(uiEditDraft);
      }
      setUiEditSavedPayload(payload);
      const summary = buildUiEditSummary(payload, uiSelection);
      try {
        await chatApi.saveSystemMessage(projectId, {
          content: summary,
          tone: 'success',
          meta: {
            uiSelection,
            uiEdits: payload,
          },
        });
        pushSystemMessage(summary, 'success');
      } catch (logError) {
        console.error('Failed to save system message:', logError);
        pushSystemMessage('Edits saved, but failed to log history.', 'error');
      }
      toast.success('Local edits saved.');
      onUiEditsSaved?.();
      return Boolean(response?.success);
    } catch (error: any) {
      console.error('Failed to save local edits:', error);
      pushSystemMessage('Failed to save local edits.', 'error');
      toast.error(error?.message || 'Failed to save local edits.');
      return false;
    } finally {
      setIsSavingEdits(false);
    }
  };

  const handleUiEditTextChange = (field: 'text' | 'placeholder' | 'value', value: string) => {
    setUiEditDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [field]: value };
    });
    onApplyUiEdit?.({ [field]: value });
  };

  const handleUiEditStyleChange = (field: string, value: string) => {
    setUiEditDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, styles: { ...prev.styles, [field]: value } };
    });
    onApplyUiEdit?.({ styles: { [field]: value } });
  };

  const uiEditsPayload = getUiEditsPayload();
  const hasUiEdits = Boolean(uiEditsPayload);
  const isUiEditsSaved =
    hasUiEdits &&
    Boolean(uiEditSavedPayload) &&
    serializeEdits(uiEditsPayload) === serializeEdits(uiEditSavedPayload);
  const savedStatusText = isSavingEdits
    ? 'Saving...'
    : !hasUiEdits && uiEditSavedPayload
    ? 'Saved.'
    : hasUiEdits
    ? isUiEditsSaved
      ? 'Saved.'
      : 'Unsaved changes.'
    : 'Adjust values to preview changes.';
  const requestDiscardUnsavedUiEdits = async () => {
    if (!hasUiEdits || isUiEditsSaved) {
      return true;
    }

    return popup.confirm({
      title: 'Discard Unsaved UI Edits?',
      message: 'You have unsaved local UI edits for this selected element. These changes will be lost.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      danger: true,
    });
  };

  const requestClearUiSelection = async () => {
    const shouldClear = await requestDiscardUnsavedUiEdits();
    if (!shouldClear) return;
    onClearUiSelection?.();
  };
  const shouldShowLocalEditor = Boolean(uiSelection && uiEditDraft && isLocalEditorOpen);
  const isSelectElement = uiSelection?.tagName?.toLowerCase() === 'select';
  const isCheckboxElement = uiSelection?.tagName?.toLowerCase() === 'input' &&
    uiSelection?.attributes?.type?.toLowerCase() === 'checkbox';
  const isRadioElement = uiSelection?.tagName?.toLowerCase() === 'input' &&
    uiSelection?.attributes?.type?.toLowerCase() === 'radio';
  const canEditText =
    uiSelection?.elementType === 'text' ||
    uiSelection?.elementType === 'other' ||
    Boolean(uiSelection?.editableText) ||
    isSelectElement;
  // Don't show Value/Placeholder for checkbox/radio - they have different semantics
  const canEditValue =
    (uiSelection?.elementType === 'input' || uiSelection?.elementType === 'textarea') &&
    !isCheckboxElement &&
    !isRadioElement;

  const dispatchMessage = async (
    messageText: string,
    options: {
      includeAttachments?: boolean;
      modeOverride?: ChatMode;
      attachmentFiles?: File[];
      providerOverride?: string | null;
      modelAliasOverride?: string | null;
      clientRequestId?: string | null;
    } = {}
  ) => {
    if (!socketRef.current || !isConnected) return;
    const includeAttachments = options.includeAttachments !== false;
    const attachmentFiles = Array.isArray(options.attachmentFiles) ? options.attachmentFiles : selectedFiles;

    setShowPlanActions(false);
    lastRequestModeRef.current = options.modeOverride ?? chatModeRef.current;

    // Reset file operations flag for new request
    fileOperationsOccurredRef.current = false;
    requestChangedFilesRef.current = new Set();
    requestChangesetRef.current = null;
    requestToolUseCountRef.current = 0;
    requestSawAssistantTextRef.current = false;

    let attachmentPaths: string[] = [];
    let uploadedFiles: UploadedFile[] = [];
    try {
      if (includeAttachments && attachmentFiles.length > 0) {
        setIsUploading(true);
        const uploadResult = await chatApi.uploadFiles(projectId, attachmentFiles);
        attachmentPaths = uploadResult.files.map((f) => f.path);
        uploadedFiles = uploadResult.files;
        toast.success(`Uploaded ${uploadResult.count} file(s)`);
      }

      const userMessage: Message = {
        id: generateId(),
        role: 'user',
        content: messageText,
        timestamp: new Date(),
        attachments: uploadedFiles.length > 0 ? uploadedFiles : undefined,
        clientRequestId: options.clientRequestId || undefined,
      };

      const uiEditsPayload = getUiEditsPayload();
      // Prefer explicit selection → auth status → OpenCode (open-source) → first available CLI → anthropic fallback
      const selectedProvider =
        options.providerOverride
        || selectedModelOption?.providerType
        || authStatus?.provider
        || availableCLIs.find((cli) => cli.type === 'opencode')?.type
        || availableCLIs[0]?.type
        || 'anthropic';
      const selectedModelAlias = options.modelAliasOverride || selectedModelOption?.alias;

      setMessages((prev) => [...prev, userMessage]);
      console.log(
        '[ChatPanel] Sending message with chatMode:',
        lastRequestModeRef.current,
        'model:',
        selectedModelAlias,
        'cli:',
        selectedProvider
      );
      socketRef.current.emit('ai-message', {
        projectId,
        message: messageText,
        attachments: attachmentPaths,
        attachmentsMeta: uploadedFiles.length > 0 ? uploadedFiles : undefined,
        uiSelection,
        uiEdits: uiEditsPayload || undefined,
        model: selectedModelAlias,
        chatMode: lastRequestModeRef.current,
        cliProvider: selectedProvider,
        clientRequestId: options.clientRequestId || undefined,
      });

      setIsTyping(true);
      onClearUiSelection?.();
    } finally {
      setIsUploading(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim()) return;

    setCommandMatches([]);
    setCommandAnchor(null);

    const invocation = parseCommandInvocation(input);
    if (invocation) {
      const matchedCommand = slashCommands.find((command) => {
        if (invocation.namespace) {
          return command.name === invocation.name && command.namespace === invocation.namespace;
        }
        return command.name === invocation.name;
      });
      const isBuiltIn = matchedCommand?.type === 'builtin';
      const isBuiltInFallback =
        !matchedCommand && !invocation.namespace && ['clear', 'help', 'compact'].includes(invocation.name);

      if (isBuiltIn || isBuiltInFallback) {
        const commandName = matchedCommand?.name || invocation.name;
        if (commandName === 'clear') {
          const cleared = await handleClearChat();
          if (cleared) {
            setInput('');
          }
          onClearUiSelection?.();
          return;
        }
        if (commandName === 'help') {
          pushSystemMessage(buildHelpMessage());
          setInput('');
          onClearUiSelection?.();
          return;
        }
        if (commandName === 'compact') {
          const compacted = await handleCompactConversation(invocation.args);
          if (compacted) {
            setInput('');
          }
          onClearUiSelection?.();
          return;
        }

        pushSystemMessage(
          `Command /${commandName} is not supported in AtlasEngine chat yet.`
        );
        setInput('');
        onClearUiSelection?.();
        return;
      }
    }

    if (!socketRef.current || !isConnected) return;

    try {
      await dispatchMessage(input);
      setInput('');
      setSelectedFiles([]);

    } catch (error: any) {
      console.error('Failed to send message:', error);
      toast.error(`Failed to send message: ${error.message || 'Unknown error'}`);
    }
  };

  const handleKeepChatting = () => {
    setShowPlanActions(false);
    inputRef.current?.focus();
  };

  const handleStartBuilding = async () => {
    if (isProcessing) return;
    setShowPlanActions(false);
    setChatMode('build');
    try {
      const lastPlanMessage = [...messages]
        .reverse()
        .find((msg) => msg.role === 'assistant' && msg.mode === 'plan' && !msg.isToolUse);
      const planText = lastPlanMessage?.content?.trim();
      const buildPrompt = planText
        ? `Proceed with the following implementation plan:\n\n${planText}`
        : 'Proceed with the implementation plan.';

      await dispatchMessage(buildPrompt, {
        includeAttachments: false,
        modeOverride: 'build',
      });
      setInput('');
      setSelectedFiles([]);

    } catch (error: any) {
      console.error('Failed to start building:', error);
      toast.error(`Failed to start building: ${error.message || 'Unknown error'}`);
    }
  };

  const getMessageStyle = (message: Message) => {
    if (message.role === 'system') {
      if (message.tone === 'success') {
        return 'bg-accent-green/20 text-accent-green';
      }
      if (message.tone === 'error') {
        return 'bg-accent-red/20 text-accent-red text-center';
      }
      if (message.tone === 'warning') {
        return 'bg-accent-yellow/20 text-accent-yellow border border-accent-yellow/30';
      }
      return 'bg-surface/80 text-content text-center border border-border/50';
    }

    switch (message.role) {
      case 'user':
        return 'bg-accent-blue text-content ml-auto';
      case 'assistant':
        return 'bg-surface-elevated text-content';
      default:
        return 'bg-surface-elevated text-content';
    }
  };

  const formatTime = (date: Date) => {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleClearChat = async () => {
    const deletableMessageCount = messages.filter((message) => message.id !== 'welcome').length;
    const confirmMessage = [
      'Delete chat history for this project?',
      `${deletableMessageCount} message${deletableMessageCount === 1 ? '' : 's'} will be removed from this chat view.`,
      'This cannot be undone.',
      '',
      'Tip: Use Compact if you only want a fresh AI context.',
    ].join('\n');

    const confirmed = await popup.confirm({
      title: 'Delete Chat History',
      message: confirmMessage,
      confirmLabel: 'Delete history',
      cancelLabel: 'Cancel',
      danger: true,
    });

    if (!confirmed) {
      return false;
    }

    try {
      const response = await axios.delete(`${getApiBaseUrl()}/chat/sessions/${projectId}/history`);
      const cliContextReset = response?.data?.cliContextReset !== false;
      setSessionMessageCount(0);
      setMessages([
        {
          id: 'welcome',
          role: 'system',
          content: cliContextReset
            ? 'Chat history cleared and AI context reset. You can start a fresh request.'
            : 'Chat history cleared. You can start a fresh request.',
          timestamp: new Date(),
          tone: cliContextReset ? 'success' : 'warning',
        },
      ]);
      setHistoryOffset(0);
      setHasMoreHistory(false);
      return true;
    } catch (error) {
      console.error('Failed to clear chat history:', error);
      setMessages((prev) => [
        ...prev,
        {
          id: generateId(),
          role: 'system',
          content: 'Error: Failed to clear chat history',
          timestamp: new Date(),
        },
      ]);
      return false;
    }
  };

  const handleCompactConversation = async (instructions?: string) => {
    if (!socketRef.current || !isConnected || isProcessing) return;

    const normalizedInstructions = instructions?.trim();
    const compactMessage = normalizedInstructions
      ? `Conversation compacted. Fresh CLI context started.\nFocus for next steps: ${normalizedInstructions}`
      : 'Conversation compacted. Fresh CLI context started.';

    return new Promise<boolean>((resolve) => {
      socketRef.current?.emit(
        'ai-new-conversation',
        { projectId },
        (response: { success: boolean; error?: string }) => {
          if (response?.success) {
            setSessionMessageCount(0);
            pushSystemMessage(compactMessage, 'success');
            chatApi.saveSystemMessage(projectId, {
              content: compactMessage,
              tone: 'success',
              meta: normalizedInstructions ? { compactInstructions: normalizedInstructions } : undefined,
            }).catch(() => {});
            resolve(true);
          } else {
            toast.error(`Failed to compact conversation: ${response?.error || 'Unknown error'}`);
            resolve(false);
          }
        }
      );
    });
  };

  const handleCompactButtonClick = async () => {
    if (!isConnected || isProcessing) return;
    const confirmed = await popup.confirm({
      title: 'Compact Conversation Context',
      message:
        'Compact this conversation and start a fresh CLI context?\n\nThis keeps project memory summaries, but resets the active chat session context.',
      confirmLabel: 'Compact context',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    await handleCompactConversation();
  };

  const handleStop = () => {
    if (!socketRef.current) return;

    // Send stop signal to backend
    socketRef.current.emit('ai-stop', { projectId });

    // Update UI state
    setIsProcessing(false);
    setIsTyping(false);
    setCurrentActivity('');

    // Add system message indicating stop
    setMessages((prev) => [
      ...prev,
      {
        id: generateId(),
        role: 'system',
        content: 'Request stopped by user',
        timestamp: new Date(),
      },
    ]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    validateAndAddFiles(files);
    // Reset so selecting the same file again triggers onChange
    e.target.value = '';
  };

  const handleAttachClick = async () => {
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
            toast.error(`Failed to read: ${filePath.split('/').pop()}`);
          }
        }
        if (fileObjects.length > 0) validateAndAddFiles(fileObjects);
      } catch (err) {
        console.error('Tauri file dialog failed, falling back to HTML input:', err);
        fileInputRef.current?.click();
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  const validateAndAddFiles = (files: File[]) => {
    const maxSize = 10 * 1024 * 1024; // 10 MB
    const allowedTypes = new Set([
      // Images
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      // Documents
      'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/css',
      'application/pdf', 'application/json',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]);
    // Also allow by extension for files where MIME type may not be set correctly
    const allowedExtensions = new Set([
      'txt', 'md', 'csv', 'html', 'css', 'json', 'pdf', 'doc', 'docx', 'xls', 'xlsx',
      'jpg', 'jpeg', 'png', 'gif', 'webp',
    ]);
    const maxFiles = 20;

    const validFiles = files.filter((file) => {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (!allowedTypes.has(file.type) && !allowedExtensions.has(ext)) {
        toast.error(`${file.name}: Unsupported file type. Use images or documents (TXT, MD, PDF, DOC, CSV, JSON, etc.)`);
        return false;
      }
      if (file.size > maxSize) {
        toast.error(`${file.name}: File size exceeds 10 MB limit.`);
        return false;
      }
      return true;
    });

    if (selectedFiles.length + validFiles.length > maxFiles) {
      toast.error(`Maximum ${maxFiles} files allowed. Please remove some files.`);
      return;
    }

    setSelectedFiles((prev) => [...prev, ...validFiles]);
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = Array.from(e.dataTransfer.files);
    validateAndAddFiles(files);
  };

  if (authStatus && !authStatus.authenticated && !authStatus.checking) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-surface)' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-6)' }}>
          <div style={{ textAlign: 'center', maxWidth: 400 }}>
            <div style={{
              width: 56,
              height: 56,
              background: 'var(--chip-warning-bg)',
              color: 'var(--accent-yellow)',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto var(--space-4)',
              fontSize: 'var(--text-2xl)',
            }}>
              !
            </div>
            <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 'var(--space-2)' }}>
              No CLI Authenticated
            </h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-4)', fontSize: 'var(--text-sm)' }}>
              A coding CLI (Claude Code, Codex, or Gemini) needs to be installed and authenticated before chat can run.
            </p>
            <div style={{
              background: 'var(--bg-base)',
              borderRadius: 'var(--radius-lg)',
              padding: 'var(--space-3)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              textAlign: 'left',
              color: 'var(--text-secondary)',
              marginBottom: 'var(--space-4)',
            }}>
              $ claude login    # for Claude Code{'\n'}
              $ codex login     # for Codex
            </div>
            <button
              onClick={() => socketRef.current?.emit('ai-check-auth', {})}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                background: 'var(--accent-blue)',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                fontSize: 'var(--text-sm)',
                fontFamily: 'var(--font-sans)',
                fontWeight: 500,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Retry Connection
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--review-panel-bg)' }}>
      {/* Header — matches Trust Pipeline's AI Review header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--review-shell-border)',
        background: 'var(--review-panel-header-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-tertiary)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 'var(--radius-full)', background: 'rgba(88, 166, 255, 0.12)', border: '1px solid rgba(88, 166, 255, 0.2)', color: 'var(--accent-blue)', fontSize: 10, fontWeight: 700 }}>&#9670; AI</span>
          Chat
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          {sessionMessageCount > 0 && (
            <span
              style={{
                fontSize: 'var(--text-xs)',
                color: sessionMessageCount >= 50 ? 'var(--accent-yellow)' : 'var(--text-tertiary)',
                whiteSpace: 'nowrap',
              }}
              title={sessionMessageCount >= 50 ? 'Consider compacting conversation for best results' : `${sessionMessageCount} messages in this session`}
            >
              {sessionMessageCount} msgs
            </span>
          )}
          <button
            onClick={() => { void handleCompactButtonClick(); }}
            disabled={isProcessing || !isConnected}
            title="Compact context and start fresh session"
            style={{
              padding: 'var(--space-1)',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-tertiary)',
              cursor: (isProcessing || !isConnected) ? 'not-allowed' : 'pointer',
              opacity: (isProcessing || !isConnected) ? 0.5 : 1,
              transition: 'color var(--transition-fast)',
              display: 'flex',
              alignItems: 'center',
            }}
            onMouseEnter={(e) => { if (!isProcessing && isConnected) e.currentTarget.style.color = 'var(--text-secondary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
          >
            {/* Compact icon (condense/reset context) */}
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 9 4 4 9 4" />
              <polyline points="15 20 20 20 20 15" />
              <line x1="4" y1="4" x2="10" y2="10" />
              <line x1="14" y1="14" x2="20" y2="20" />
              <polyline points="20 9 20 4 15 4" />
              <polyline points="9 20 4 20 4 15" />
              <line x1="14" y1="10" x2="20" y2="4" />
              <line x1="4" y1="20" x2="10" y2="14" />
            </svg>
          </button>
          {/* Search toggle button */}
          <button
            onClick={() => { setIsSearchOpen(!isSearchOpen); if (isSearchOpen) { setSearchQuery(''); setSearchResults([]); setActiveSearchIndex(-1); } }}
            title="Search messages"
            style={{
              padding: 'var(--space-1)',
              background: isSearchOpen ? 'rgba(88, 166, 255, 0.1)' : 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: isSearchOpen ? 'var(--text-primary)' : 'var(--text-tertiary)',
              cursor: 'pointer',
              transition: 'color var(--transition-fast)',
              display: 'flex',
              alignItems: 'center',
            }}
            onMouseEnter={(e) => { if (!isSearchOpen) e.currentTarget.style.color = 'var(--text-secondary)'; }}
            onMouseLeave={(e) => { if (!isSearchOpen) e.currentTarget.style.color = 'var(--text-tertiary)'; }}
          >
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button
            onClick={handleClearChat}
            disabled={messages.length === 0 || isLoadingHistory}
            title="Clear chat history"
            style={{
              padding: 'var(--space-1)',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-tertiary)',
              cursor: (messages.length === 0 || isLoadingHistory) ? 'not-allowed' : 'pointer',
              opacity: (messages.length === 0 || isLoadingHistory) ? 0.5 : 1,
              transition: 'color var(--transition-fast)',
              display: 'flex',
              alignItems: 'center',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
          >
            <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: isConnected ? 'var(--accent-green)' : 'var(--accent-red)',
            }} />
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
      </div>

      {/* Session search bar */}
      {isSearchOpen && (
        <div className="px-3 py-2 flex items-center gap-2" style={{ borderBottom: '1px solid var(--review-shell-border)', background: 'rgba(9, 13, 22, 0.58)' }}>
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-content-secondary shrink-0">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              const q = e.target.value;
              setSearchQuery(q);
              if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
              if (q.length >= 2) {
                searchDebounceRef.current = setTimeout(async () => {
                  try {
                    const response = await axios.get(`${getApiBaseUrl()}/chat/sessions/${projectId}/search`, { params: { q } });
                    const results = (response.data.results || []).map((r: any) => ({ id: r.id, content: r.content }));
                    setSearchResults(results);
                    setActiveSearchIndex(results.length > 0 ? 0 : -1);
                    // Scroll to first result via Virtuoso index
                    if (results.length > 0) {
                      scrollToMessageId(results[0].id);
                    }
                  } catch {
                    setSearchResults([]);
                  }
                }, 300);
              } else {
                setSearchResults([]);
                setActiveSearchIndex(-1);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && searchResults.length > 0) {
                e.preventDefault();
                const next = Math.min(activeSearchIndex + 1, searchResults.length - 1);
                setActiveSearchIndex(next);
                scrollToMessageId(searchResults[next].id);
              } else if (e.key === 'ArrowUp' && searchResults.length > 0) {
                e.preventDefault();
                const prev = Math.max(activeSearchIndex - 1, 0);
                setActiveSearchIndex(prev);
                scrollToMessageId(searchResults[prev].id);
              } else if (e.key === 'Escape') {
                setIsSearchOpen(false);
                setSearchQuery('');
                setSearchResults([]);
                setActiveSearchIndex(-1);
              }
            }}
            placeholder="Search messages..."
            className="flex-1 bg-transparent text-sm text-content placeholder-content-tertiary outline-none"
            autoFocus
          />
          {searchResults.length > 0 && (
            <span className="text-xs text-content-secondary shrink-0">
              {activeSearchIndex + 1}/{searchResults.length}
            </span>
          )}
          {searchQuery.length >= 2 && searchResults.length === 0 && (
            <span className="text-xs text-content-tertiary shrink-0">No results</span>
          )}
        </div>
      )}

      {/* Messages — virtualized for large sessions */}
      <div ref={messagesContainerRef} className="flex-1 overflow-hidden min-w-0" style={{ background: 'linear-gradient(180deg, rgba(14, 20, 32, 0.94) 0%, rgba(10, 14, 22, 0.98) 100%)' }}>
        {isLoadingHistory && (
          <div className="text-center text-content-tertiary text-sm mt-8 p-4">
            <p className="mb-2">Loading chat history...</p>
          </div>
        )}

        {!isLoadingHistory && messages.length === 0 && (
          <div className="text-center text-content-tertiary text-sm mt-8 p-4">
            <p className="mb-2">No messages yet</p>
            <p className="text-xs">
              Start a conversation with Claude Code to get help with your project
            </p>
          </div>
        )}

        {!isLoadingHistory && groupedTurns.length > 0 && (
          <Virtuoso
            ref={virtuosoRef}
            firstItemIndex={virtuosoFirstItemIndex}
            data={groupedTurns}
            followOutput="smooth"
            atTopStateChange={(atTop: boolean) => {
              if (atTop && hasMoreHistory && !isLoadingMore) {
                loadOlderMessages();
              }
            }}
            components={{
              Header: () => (
                !isLoadingHistory && hasMoreHistory ? (
                  <div className="flex justify-center p-2">
                    <button
                      onClick={loadOlderMessages}
                      disabled={isLoadingMore}
                      className="px-3 py-1 text-xs bg-surface-elevated hover:bg-surface-hover disabled:bg-surface-elevated/50 rounded"
                    >
                      {isLoadingMore ? 'Loading older messages...' : 'Load older messages'}
                    </button>
                  </div>
                ) : null
              ),
              Footer: () => (
                isTyping ? (
                  <div className="flex justify-start p-4 pb-2">
                    <div className="bg-surface-elevated rounded-lg p-3">
                      <div className="flex gap-1">
                        <div className="w-2 h-2 bg-content-secondary rounded-full animate-bounce"></div>
                        <div className="w-2 h-2 bg-content-secondary rounded-full animate-bounce delay-100"></div>
                        <div className="w-2 h-2 bg-content-secondary rounded-full animate-bounce delay-200"></div>
                      </div>
                    </div>
                  </div>
                ) : <div ref={messagesEndRef} />
              ),
            }}
            style={{ height: '100%' }}
            className="py-4"
            itemContent={(_index: number, turn: GroupedTurn) => (
              <div
                data-turn-id={turn.id}
                data-turn-anchor={getTurnAnchorId(turn)}
                className="space-y-3 pb-3 px-3"
              >
                {/* User message */}
                {turn.userMessage && (
                  <div
                    data-message-id={turn.userMessage.id}
                    className="flex justify-end"
                  >
                    <div
                      className="max-w-[92%] rounded-[22px] px-5 py-3 ml-auto overflow-hidden break-words"
                      style={{
                        background: 'rgba(17, 55, 66, 0.92)',
                        border: '1px solid rgba(31, 184, 220, 0.34)',
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
                        color: '#35d7f6',
                      }}
                    >
                      <div className="text-sm prose prose-invert prose-sm max-w-none break-words leading-[1.28]">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          urlTransform={defaultUrlTransform}
                          components={{
                            p: ({children, node}) => {
                              const startColumn = node?.position?.start?.column ?? 0;
                              const isInListItem = startColumn > 1;
                              return isInListItem ?
                                <>{children}</> :
                                <p className="mb-1 last:mb-0">{children}</p>;
                            },
                            h1: ({children}) => <h1 className="text-xl font-bold mb-1 mt-2 first:mt-0">{children}</h1>,
                            h2: ({children}) => <h2 className="text-lg font-bold mb-1 mt-2 first:mt-0">{children}</h2>,
                            h3: ({children}) => <h3 className="text-base font-bold mb-1 mt-1.5 first:mt-0">{children}</h3>,
                            ul: ({children}) => <ul className="list-disc list-outside mb-1 ml-4 space-y-0">{children}</ul>,
                            ol: ({children}) => <ol className="list-decimal list-outside mb-1 ml-4 space-y-0">{children}</ol>,
                            li: ({children}) => <li className="leading-[1.28]">{children}</li>,
                            code: ({inline, children, ...props}: any) =>
                              inline ? (
                                <code className="px-1.5 py-0.5 rounded font-mono text-xs" style={{ background: 'rgba(53, 215, 246, 0.14)', color: '#b8f4ff' }} {...props}>
                                  {children}
                                </code>
                              ) : (
                                <code className="font-mono text-xs" {...props}>
                                  {children}
                                </code>
                              ),
                            pre: ({children}) => <pre className="bg-surface-elevated rounded p-3 overflow-x-auto my-2 text-sm">{children}</pre>,
                            a: ({children, href}) => isDevServerUrl(href) ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-accent-blue/20 text-accent-blue">
                                See Preview Panel →
                              </span>
                            ) : (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline"
                                style={{ color: '#7ae8ff' }}
                              >
                                {children}
                              </a>
                            ),
                            strong: ({children}) => <strong style={{ color: '#b8f4ff' }} className="font-bold">{children}</strong>,
                            em: ({children}) => <em style={{ color: '#9cecff' }} className="italic">{children}</em>,
                          }}
                        >
                          {turn.userMessage.content}
                        </ReactMarkdown>
                      </div>
                      {turn.userMessage.attachments && turn.userMessage.attachments.length > 0 && renderMessageAttachments(turn.userMessage.attachments)}
                      <div className="text-xs mt-0.5 leading-none" style={{ color: 'rgba(184, 244, 255, 0.56)' }}>
                        {formatTime(turn.userMessage.timestamp)}
                      </div>
                    </div>
                  </div>
                )}

                {/* Assistant message (includes system messages) */}
                {turn.assistantMessage && !turn.assistantMessage.isToolUse && (() => {
                  const { thinking, body } = !turn.assistantMessage.isStreaming
                    ? splitThinkingContent(turn.assistantMessage.content)
                    : { thinking: null, body: turn.assistantMessage.content };
                  return (
                  <div
                    data-message-id={turn.assistantMessage.id}
                    className="flex justify-start"
                  >
                    <div className={`max-w-[92%] rounded-lg p-3 overflow-hidden break-words ${getMessageStyle(turn.assistantMessage)}`}>
                      {/* Mode pill */}
                      {turn.mode && turn.mode !== 'agent' && turn.assistantMessage.role === 'assistant' && (
                        <div className="mb-2">
                          <span
                            className={`text-[10px] uppercase font-medium px-1.5 py-0.5 rounded ${
                              turn.mode === 'plan'
                                ? 'bg-accent-purple/20 text-accent-purple'
                                : 'bg-accent-green/20 text-accent-green'
                            }`}
                          >
                            {turn.mode}
                          </span>
                        </div>
                      )}
                      {/* Thinking/reasoning collapsible section */}
                      {thinking && (
                        <details className="mb-2 group">
                          <summary className="cursor-pointer text-xs text-accent-purple hover:text-accent-purple/80 select-none flex items-center gap-1">
                            <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                            Show reasoning
                          </summary>
                          <div className="mt-1 pl-4 border-l-2 border-purple-500/30 text-xs text-content-secondary italic whitespace-pre-wrap break-words">
                            {thinking}
                          </div>
                        </details>
                      )}
                      <div className="text-sm prose prose-invert prose-sm max-w-none break-words">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            p: ({children, node}) => {
                              const startColumn = node?.position?.start?.column ?? 0;
                              const isInListItem = startColumn > 1;
                              return isInListItem ?
                                <>{children}</> :
                                <p className="mb-2 last:mb-0">{children}</p>;
                            },
                            h1: ({children}) => <h1 className="text-xl font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
                            h2: ({children}) => <h2 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
                            h3: ({children}) => <h3 className="text-base font-bold mb-2 mt-2 first:mt-0">{children}</h3>,
                            ul: ({children}) => <ul className="list-disc list-outside mb-2 ml-4 space-y-0.5">{children}</ul>,
                            ol: ({children}) => <ol className="list-decimal list-outside mb-2 ml-4 space-y-0.5">{children}</ol>,
                            li: ({children}) => <li className="leading-relaxed">{children}</li>,
                            code: ({inline, children, ...props}: any) =>
                              inline ? (
                                <code className="px-1.5 py-0.5 bg-surface-elevated rounded text-accent-blue font-mono text-xs" {...props}>
                                  {children}
                                </code>
                              ) : (
                                <code className="font-mono text-xs" {...props}>
                                  {children}
                                </code>
                              ),
                            pre: ({children}) => <pre className="bg-surface-base rounded p-3 overflow-x-auto my-2 text-sm">{children}</pre>,
                            blockquote: ({children}) => (
                              <blockquote className="border-l-4 border-accent-blue pl-3 italic text-content my-2">
                                {children}
                              </blockquote>
                            ),
                            a: ({children, href}) => {
                              const route = extractRouteFromAtlasHref(href);
                              if (route) {
                                return (
                                  <button
                                    onClick={() => {
                                      if (!route) return;
                                      window.dispatchEvent(new CustomEvent('atlas-navigate-preview-route', { detail: { route } }));
                                      window.dispatchEvent(new CustomEvent('atlas-navigate-to-preview'));
                                    }}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-accent-green/20 text-accent-green hover:bg-accent-green/30 cursor-pointer border border-accent-green/30"
                                  >
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                    {children}
                                  </button>
                                );
                              }
                              if (isDevServerUrl(href)) {
                                return (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-accent-blue/20 text-accent-blue">
                                    See Preview Panel →
                                  </span>
                                );
                              }
                              return (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-accent-blue hover:text-accent-blue/80 underline"
                                >
                                  {children}
                                </a>
                              );
                            },
                            table: ({children}) => (
                              <div className="overflow-x-auto my-2">
                                <table className="min-w-full border-collapse border border-border-strong">
                                  {children}
                                </table>
                              </div>
                            ),
                            thead: ({children}) => <thead className="bg-surface-elevated">{children}</thead>,
                            th: ({children}) => <th className="border border-border-strong px-3 py-2 text-left">{children}</th>,
                            td: ({children}) => <td className="border border-border-strong px-3 py-2">{children}</td>,
                            strong: ({children}) => <strong className="font-bold text-content">{children}</strong>,
                            em: ({children}) => <em className="italic text-content">{children}</em>,
                            hr: () => <hr className="border-border-strong my-3" />,
                          }}
                        >
                          {body}
                        </ReactMarkdown>
                        {turn.assistantMessage.isStreaming && (
                          <span className="inline-block w-2 h-4 bg-current ml-1 animate-pulse"></span>
                        )}
                      </div>
                      {turn.assistantMessage.attachments && turn.assistantMessage.attachments.length > 0 && renderMessageAttachments(turn.assistantMessage.attachments)}
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-content-secondary">
                          {formatTime(turn.assistantMessage.timestamp)}
                        </span>
                        {!turn.assistantMessage.isStreaming && turn.assistantMessage.role === 'assistant' && turn.assistantMessage.tokensUsed && turn.assistantMessage.tokensUsed > 0 && (
                          <span className="text-[10px] text-content-tertiary bg-surface px-1.5 py-0.5 rounded">
                            {turn.assistantMessage.tokensUsed.toLocaleString()} tokens ({estimateCost(turn.assistantMessage.tokensUsed, turn.assistantMessage.model)})
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  );
                })()}

                {/* ActionStrip for tool events */}
                {turn.toolEvents.length > 0 && (
                  <div className="pl-0">
                    <ActionStrip
                      summary={turn.summary}
                      expanded={expandedTurns.has(turn.id)}
                      onToggle={() => handleToggleTurn(turn.id)}
                      toolEvents={turn.toolEvents}
                    />
                  </div>
                )}
              </div>
            )}
          />
        )}
      </div>

      {/* Input */}
      <div
        className="p-4 relative"
        style={{ borderTop: '1px solid var(--review-shell-border)', background: 'var(--review-panel-header-bg)' }}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {(uiSelection || isSelectingUi) && (
          <div className="mb-3 flex items-center gap-2 text-xs">
            {uiSelection ? (
              <div className="flex items-center gap-2 bg-surface-base border border-accent-blue/30 text-accent-blue px-2 py-1 rounded">
                <span>UI selected</span>
                <span className="text-content">{getSelectionLabel(uiSelection)}</span>
                {!isLocalEditorOpen && (
                  <button
                    type="button"
                    onClick={() => setIsLocalEditorOpen(true)}
                    className="ml-2 text-[11px] text-accent-blue hover:text-accent-blue/80"
                  >
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { void requestClearUiSelection(); }}
                  className="ml-2 text-content-secondary hover:text-accent-red"
                  title="Clear selection"
                >
                  ×
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-accent-blue">
                <span className="font-medium">Select UI:</span>
                <span>Click an element in the preview to attach context.</span>
                <button
                  type="button"
                  onClick={() => onClearUiSelection?.()}
                  className="ml-2 text-content-secondary hover:text-accent-red"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
        {shouldShowLocalEditor && (
          <div className="mb-3 rounded border border-border bg-surface-base/70 p-3 text-xs">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-content">Local editor</span>
              <span className="text-[10px] text-content-tertiary">
                {hasUiEdits ? 'Edits ready' : 'Live preview'}
              </span>
            </div>
            {canEditText && (
              <div className="mb-2">
                <label className="block text-[11px] text-content-secondary mb-1">Text</label>
                <input
                  type="text"
                  value={uiEditDraft!.text}
                  onChange={(event) => handleUiEditTextChange('text', event.target.value)}
                  className="w-full px-2 py-1 bg-surface border border-border rounded text-xs text-content"
                />
              </div>
            )}
            {canEditValue && (
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <label className="block text-[11px] text-content-secondary mb-1">Value</label>
                  <input
                    type="text"
                    value={uiEditDraft!.value}
                    onChange={(event) => handleUiEditTextChange('value', event.target.value)}
                    className="w-full px-2 py-1 bg-surface border border-border rounded text-xs text-content"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-content-secondary mb-1">Placeholder</label>
                  <input
                    type="text"
                    value={uiEditDraft!.placeholder}
                    onChange={(event) => handleUiEditTextChange('placeholder', event.target.value)}
                    className="w-full px-2 py-1 bg-surface border border-border rounded text-xs text-content"
                  />
                </div>
              </div>
            )}
            {(isCheckboxElement || isRadioElement) && (
              <div className="mb-2 grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-content-secondary mb-1">
                    {isCheckboxElement ? 'Checkbox' : 'Radio'}
                  </label>
                  <div className="px-2 py-1 bg-surface border border-border rounded text-xs text-content-secondary">
                    {uiSelection?.attributes?.checked !== undefined ? 'Checked' : 'Unchecked'}
                  </div>
                </div>
                {uiSelection?.locator?.ariaLabel && (
                  <div>
                    <label className="block text-[11px] text-content-secondary mb-1">Label</label>
                    <div className="px-2 py-1 bg-surface border border-border rounded text-xs text-content truncate">
                      {uiSelection.locator.ariaLabel}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {STYLE_FIELDS.map((field) => (
                <div key={field.key}>
                  <label className="block text-[11px] text-content-secondary mb-1">
                    {field.label}
                  </label>
                  <input
                    type="text"
                    value={uiEditDraft!.styles[field.key] || ''}
                    onChange={(event) => handleUiEditStyleChange(field.key, event.target.value)}
                    placeholder={field.placeholder}
                    className="w-full px-2 py-1 bg-surface border border-border rounded text-xs text-content placeholder-content-tertiary"
                  />
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[10px] text-content-tertiary">{savedStatusText}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    handleUiEditReset();
                  }}
                  disabled={!hasUiEdits}
                  className="px-2 py-1 rounded bg-surface border border-border text-[11px] text-content hover:bg-surface-hover disabled:opacity-50"
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const saved = await handleUiEditSave();
                    if (saved) {
                      setIsLocalEditorOpen(false);
                    }
                  }}
                  disabled={!hasUiEdits || isSavingEdits || isUploading}
                  className="px-2 py-1 rounded bg-accent-blue text-[11px] text-content hover:bg-accent-blue/80 disabled:opacity-50"
                >
                  {isSavingEdits ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
        {commandMatches.length > 0 && (
          <div className="absolute bottom-full left-4 right-4 mb-2 max-h-64 overflow-auto rounded-lg border border-border bg-surface-base shadow-lg z-10">
            {commandMatches.map((command, index) => {
              const isActive = index === commandIndex;
              const scopeLabel = getCommandScopeLabel(command);
              return (
                <button
                  key={`${command.command}-${scopeLabel}`}
                  type="button"
                  ref={isActive ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applySlashCommand(command)}
                  className={`w-full text-left px-3 py-2 border-b border-border-muted last:border-b-0 ${
                    isActive ? 'bg-surface-elevated/70' : 'hover:bg-surface/70'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm text-accent-blue">
                      {getCommandInvocation(command)}
                    </span>
                    <span className="text-[10px] uppercase text-content-secondary">{scopeLabel}</span>
                  </div>
                  {command.description && (
                    <div className="text-xs text-content-secondary mt-1">{command.description}</div>
                  )}
                  {command.argumentHint && (
                    <div className="text-xs text-content-tertiary mt-1">
                      Args: {command.argumentHint}
                    </div>
                  )}
                  {command.type === 'builtin' && !command.supported && (
                    <div className="text-[10px] uppercase text-accent-yellow mt-1">
                      Not supported here
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {/* Screenshot hint — shown above chat input, auto-dismisses after 5s */}
        {isCapturingScreenshot && <ScreenshotHint />}
        {/* File Attachments Preview */}
        {selectedFiles.length > 0 && (
          <div className="mb-3 flex gap-2 flex-wrap">
            {selectedFiles.map((file, index) => {
              const isImage = file.type.startsWith('image/');
              const ext = file.name.split('.').pop()?.toLowerCase() || '';
              const docIcons: Record<string, string> = {
                pdf: '\u{1F4D5}', doc: '\u{1F4C4}', docx: '\u{1F4C4}',
                txt: '\u{1F4DD}', md: '\u{1F4DD}', csv: '\u{1F4CA}',
                json: '\u{1F4CB}', html: '\u{1F310}', css: '\u{1F3A8}',
                xls: '\u{1F4CA}', xlsx: '\u{1F4CA}',
              };
              return (
                <div
                  key={index}
                  className="relative bg-surface-base border border-border rounded p-2 flex items-center gap-2"
                >
                  {isImage ? (
                    <img
                      src={URL.createObjectURL(file)}
                      alt={file.name}
                      className="w-12 h-12 object-cover rounded cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => setLightboxImage({ src: URL.createObjectURL(file), alt: file.name })}
                      title="Click to preview"
                    />
                  ) : (
                    <div className="w-12 h-12 flex items-center justify-center bg-surface rounded text-2xl">
                      {docIcons[ext] || '\u{1F4C4}'}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-content truncate">{file.name}</div>
                    <div className="text-xs text-content-tertiary">{file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}</div>
                  </div>
                  <button
                    onClick={() => handleRemoveFile(index)}
                    className="text-content-secondary hover:text-accent-red"
                    title="Remove file"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.gif,.webp,.txt,.md,.csv,.html,.css,.json,.pdf,.doc,.docx,.xls,.xlsx"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Textarea on top - full width */}
        <div className="relative">
          {showPlanActions && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <div className="w-full bg-surface-base/90 border border-accent-blue/40 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shadow-lg">
                <div className="text-sm text-content">
                  Plan response complete. Choose how to proceed.
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleKeepChatting}
                    className="px-3 py-2 text-xs font-medium text-content bg-surface hover:bg-surface-hover border border-border-strong rounded"
                  >
                    Keep chatting
                  </button>
                  <button
                    type="button"
                    onClick={handleStartBuilding}
                    className="px-3 py-2 text-xs font-medium text-content bg-accent-blue hover:bg-accent-blue/80 rounded"
                  >
                    Start building
                  </button>
                </div>
              </div>
            </div>
          )}
          <textarea
            ref={inputRef}
            value={isProcessing ? '' : input}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onClick={handleInputSelect}
            onKeyUp={handleInputSelect}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            placeholder={
              isProcessing
                ? currentActivity
                : isConnected
                ? 'Ask Claude Code anything...'
                : 'Connecting to chat...'
            }
            data-gramm="false"
            data-gramm_editor="false"
            data-enable-grammarly="false"
            spellCheck={false}
            disabled={!isConnected || isProcessing || isUploading || showPlanActions}
            className="w-full px-3 py-3 rounded-lg text-sm text-content placeholder-content-tertiary focus:outline-none resize-none disabled:opacity-75"
            style={{
              background: 'var(--review-code-bg)',
              border: '1px solid var(--review-shell-border)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02)',
              userSelect: 'text',
            }}
            rows={2}
          />
        </div>

        {/* Buttons row below textarea */}
        <div className="mt-2 flex items-center justify-between">
          {/* Left side buttons */}
          <div className="flex items-center gap-1">
            <div className="relative" ref={selectMenuRef}>
              <button
                type="button"
                onClick={() => {
                  if (uiSelection || isSelectingUi) {
                    void requestClearUiSelection();
                    setShowSelectMenu(false);
                  } else if (isCapturingScreenshot) {
                    onCancelScreenshot?.();
                    setShowSelectMenu(false);
                  } else {
                    setShowSelectMenu((prev) => !prev);
                  }
                }}
                disabled={!isConnected || isProcessing || isUploading}
                className={`p-2 rounded text-sm ${
                  uiSelection || isSelectingUi
                    ? 'bg-accent-blue text-content hover:bg-accent-blue/80'
                    : isCapturingScreenshot
                      ? 'bg-accent-purple text-content hover:bg-accent-purple/80'
                      : 'text-content-secondary hover:text-content hover:bg-surface-hover'
                } disabled:opacity-50`}
                title={isSelectingUi ? 'Cancel element selection' : isCapturingScreenshot ? 'Cancel screenshot' : 'Select tool'}
              >
                <svg
                  className="w-5 h-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3.5" y="3.5" width="10" height="10" rx="2" strokeDasharray="3 3" />
                  <path d="M12 8l7 2.5-3 1.2-1.2 3L12 8z" fill="currentColor" />
                </svg>
              </button>
              {showSelectMenu && (
                <div
                  className="absolute bottom-full left-0 mb-1 bg-surface border border-border rounded-md shadow-lg py-1 min-w-[140px] z-50"
                  onClick={() => setShowSelectMenu(false)}
                >
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-xs text-content-secondary hover:text-content hover:bg-surface-hover flex items-center gap-2"
                    onClick={() => {
                      onStartUiSelection?.();
                    }}
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3.5" y="3.5" width="10" height="10" rx="2" strokeDasharray="3 3" />
                      <path d="M12 8l7 2.5-3 1.2-1.2 3L12 8z" fill="currentColor" />
                    </svg>
                    Elements
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-xs text-content-secondary hover:text-content hover:bg-surface-hover flex items-center gap-2"
                    onClick={() => {
                      onStartScreenshot?.();
                    }}
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="M21 15l-5-5L5 21" />
                    </svg>
                    Screenshot
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={handleAttachClick}
              disabled={!isConnected || isProcessing || isUploading}
              className="p-2 text-content-secondary hover:text-content hover:bg-surface-hover rounded disabled:opacity-50"
              title="Attach files"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
            </button>
          </div>

          {/* Right side - Mode selector, Model selector, and Send/Stop button */}
          <div className="flex items-center gap-2 min-w-0">
            {/* Chat Mode Selector */}
            <select
              value={chatMode}
              onChange={(e) => {
                const nextMode = e.target.value as ChatMode;
                chatModeRef.current = nextMode;
                setChatMode(nextMode);
              }}
              disabled={isProcessing}
              title={`Chat mode (${chatModeShortcut} to cycle)`}
              className={`rounded px-2 py-1 text-xs focus:outline-none disabled:opacity-50 ${
                chatMode === 'plan'
                  ? 'border-accent-blue border text-accent-blue'
                  : chatMode === 'build'
                  ? 'border-accent-green border text-accent-green'
                  : 'border text-content focus:border-accent-blue'
              }`}
              style={{
                background: 'var(--review-segment-bg)',
                borderColor:
                  chatMode === 'plan'
                    ? undefined
                    : chatMode === 'build'
                    ? undefined
                    : 'var(--review-shell-border)',
              }}
            >
              <option value="agent">Agent</option>
              <option value="plan">Plan</option>
              <option value="build">Build</option>
            </select>

            {/* Unified Model Selector */}
            {authStatus?.authenticated && availableModels.length > 0 && (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isProcessing || isLoadingModels}
                className="rounded px-2 py-1 text-xs text-content focus:outline-none focus:border-accent-blue disabled:opacity-50 transition-[width] duration-150 min-w-0 truncate"
                style={{
                  background: 'var(--review-segment-bg)',
                  border: '1px solid var(--review-shell-border)',
                  width: Math.min(modelDropdownWidth, 180),
                }}
                title="Select model"
              >
                {Object.entries(
                  availableModels.reduce<Record<string, BuildModelOption[]>>((groups, model) => {
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

            {isProcessing ? (
              <button
                onClick={handleStop}
                className="shrink-0 p-2 bg-accent-red hover:bg-accent-red/80 rounded text-content"
                title="Stop"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={(!input.trim() && selectedFiles.length === 0) || !isConnected || isUploading || showPlanActions}
                className="shrink-0 p-2 bg-accent-blue hover:bg-accent-blue/80 disabled:bg-surface-elevated disabled:text-content-tertiary rounded text-content"
                title="Send"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
        />
      )}
    </div>
  );
}

export default ChatPanel;
