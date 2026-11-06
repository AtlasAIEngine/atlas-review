/**
 * Chat Message Taxonomy Types
 * Defines classification system for conversation-first chat UI
 */

// Message categories for grouping and display logic
export type MessageCategory =
  | 'conversation.user'
  | 'conversation.assistant'
  | 'event.tool'
  | 'event.system';

// Tool event types for ActionStrip grouping
export type ToolEventType =
  | 'glob'
  | 'read'
  | 'write'
  | 'edit'
  | 'bash'
  | 'task'
  | 'system'  // Internal tools that shouldn't be displayed (EnterPlanMode, etc.)
  | 'other';

// File diff information for Write/Edit tools
export interface FileDiff {
  filePath: string;
  beforeContent: string | null;
  afterContent: string;
  isNewFile: boolean;
  language: string;
  stats: { additions: number; deletions: number };
}

// Attachment type - uses 'any' to avoid circular import issues with api.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MessageAttachment = any;

// Base message interface (matches existing ChatPanel Message interface)
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  attachments?: MessageAttachment[];
  tone?: 'success' | 'error' | 'warning';
  fileDiff?: FileDiff;
  tokensUsed?: number;
  model?: string;
}

// Extended message with category classification
export interface ChatMessage extends Message {
  category: MessageCategory;
  toolEventType?: ToolEventType;
  mode?: 'plan' | 'build' | 'agent';  // Mode when message was created
  tokensUsed?: number;
  model?: string;
}

// Tool summary for ActionStrip display
export interface ToolSummary {
  searches: number;  // Glob, Grep
  reads: number;     // Read
  writes: number;    // Write, Edit, NotebookEdit
  commands: number;  // Bash
  tasks: number;     // Task* tools
  other: number;     // Any other tools
  status: 'success' | 'warning' | 'error';
}

/**
 * Categorize a message based on its role and properties
 */
export function categorizeMessage(msg: Message): MessageCategory {
  if (msg.role === 'system') {
    return 'event.system';
  }

  if (msg.role === 'user') {
    return 'conversation.user';
  }

  // Assistant messages
  if (msg.isToolUse) {
    return 'event.tool';
  }

  return 'conversation.assistant';
}

/**
 * Get tool event type from tool name for grouping
 */
export function getToolEventType(toolName: string): ToolEventType {
  const normalizedName = toolName.toLowerCase();

  // System tools that shouldn't be displayed in ActionStrip
  if (
    normalizedName === 'enterplanmode' ||
    normalizedName === 'exitplanmode' ||
    normalizedName === 'askfollowupquestion'
  ) {
    return 'system';
  }

  // Search tools
  if (normalizedName === 'glob' || normalizedName === 'grep') {
    return 'glob';
  }

  // Read tool
  if (normalizedName === 'read') {
    return 'read';
  }

  // Write tools
  if (
    normalizedName === 'write' ||
    normalizedName === 'edit' ||
    normalizedName === 'notebookedit'
  ) {
    return 'write';
  }

  // Command execution
  if (normalizedName === 'bash') {
    return 'bash';
  }

  // Task management tools
  if (normalizedName.startsWith('task')) {
    return 'task';
  }

  return 'other';
}

/**
 * Create a ChatMessage from a base Message
 */
export function createChatMessage(msg: Message): ChatMessage {
  const category = categorizeMessage(msg);
  const toolEventType =
    msg.isToolUse && msg.toolName ? getToolEventType(msg.toolName) : undefined;

  return {
    ...msg,
    category,
    toolEventType,
  };
}

/**
 * Create an empty tool summary
 */
export function createEmptyToolSummary(): ToolSummary {
  return {
    searches: 0,
    reads: 0,
    writes: 0,
    commands: 0,
    tasks: 0,
    other: 0,
    status: 'success',
  };
}
