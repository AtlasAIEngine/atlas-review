/**
 * Chat Grouping Utility
 * Groups chat messages into turns for conversation-first display
 */

import type {
  ChatMessage,
  ToolSummary,
  ToolEventType,
  Message,
} from '@/types/chat';
import {
  createChatMessage,
  createEmptyToolSummary,
} from '@/types/chat';

/**
 * A grouped turn represents a user-assistant exchange with associated tool events
 */
export interface GroupedTurn {
  id: string;
  userMessage?: ChatMessage;
  assistantMessage?: ChatMessage;
  toolEvents: ChatMessage[];
  summary: ToolSummary;
  mode?: 'plan' | 'build' | 'agent';  // Mode when turn was created
}

/**
 * Increment the appropriate counter in ToolSummary based on tool type
 */
function incrementToolCount(
  summary: ToolSummary,
  toolEventType: ToolEventType
): void {
  switch (toolEventType) {
    case 'glob':
      summary.searches++;
      break;
    case 'read':
      summary.reads++;
      break;
    case 'write':
    case 'edit':
      summary.writes++;
      break;
    case 'bash':
      summary.commands++;
      break;
    case 'task':
      summary.tasks++;
      break;
    case 'system':
      // System tools (EnterPlanMode, ExitPlanMode, AskFollowupQuestion) are not counted
      break;
    default:
      summary.other++;
  }
}

/**
 * Check if a tool event should be displayed in the UI
 * Filters out system/internal tools
 */
function isVisibleToolEvent(msg: ChatMessage): boolean {
  return msg.toolEventType !== 'system';
}

/**
 * Determine summary status based on tool event content
 * Checks for error patterns in tool outputs
 */
function determineSummaryStatus(toolEvents: ChatMessage[]): 'success' | 'warning' | 'error' {
  let hasWarning = false;

  for (const event of toolEvents) {
    const content = (event.content || '').toLowerCase();
    const toolInput = event.toolInput;

    // Check for error patterns in content
    if (
      content.includes('error:') ||
      content.includes('failed') ||
      content.includes('exception')
    ) {
      return 'error';
    }

    // Check for warnings
    if (
      content.includes('warning:') ||
      content.includes('warn:') ||
      content.includes('deprecated')
    ) {
      hasWarning = true;
    }

    // For Bash commands, check if there's indication of failure in input/output
    if (event.toolName?.toLowerCase() === 'bash' && toolInput) {
      // If toolInput contains command and output shows exit code != 0
      const inputStr = JSON.stringify(toolInput).toLowerCase();
      if (inputStr.includes('exit code') && !inputStr.includes('exit code 0')) {
        return 'error';
      }
    }
  }

  return hasWarning ? 'warning' : 'success';
}

/**
 * Compute tool summary from a list of tool events
 */
export function computeToolSummary(toolEvents: ChatMessage[]): ToolSummary {
  const summary = createEmptyToolSummary();

  for (const event of toolEvents) {
    if (event.toolEventType) {
      incrementToolCount(summary, event.toolEventType);
    }
  }

  summary.status = determineSummaryStatus(toolEvents);

  return summary;
}

/**
 * Group chat messages into turns for conversation-first display
 *
 * Grouping logic:
 * - Start new turn on user message
 * - Attach assistant message to current turn
 * - Attach subsequent tool events to the assistant message's turn
 * - Tool events without preceding assistant -> "orphan" turn with no assistant
 * - System messages with success/error tone are displayed inline (not grouped)
 */
export function groupChatTimeline(messages: Message[]): GroupedTurn[] {
  const turns: GroupedTurn[] = [];
  let currentTurn: GroupedTurn | null = null;
  let turnCounter = 0;

  // Convert messages to ChatMessages with categories
  const chatMessages = messages.map((msg) => createChatMessage(msg));

  for (const msg of chatMessages) {
    const category = msg.category;

    if (category === 'conversation.user') {
      // Start a new turn with user message
      if (currentTurn) {
        // Finalize previous turn
        currentTurn.summary = computeToolSummary(currentTurn.toolEvents);
        turns.push(currentTurn);
      }
      turnCounter++;
      currentTurn = {
        id: `turn-${turnCounter}`,
        userMessage: msg,
        toolEvents: [],
        summary: createEmptyToolSummary(),
      };
    } else if (category === 'conversation.assistant') {
      // Assistant message - attach to current turn or create new orphan turn
      if (!currentTurn) {
        turnCounter++;
        currentTurn = {
          id: `turn-${turnCounter}`,
          toolEvents: [],
          summary: createEmptyToolSummary(),
          mode: msg.mode,  // Capture mode from assistant message
        };
      }
      // Only set assistantMessage if not already set (keep first non-tool assistant message)
      if (!currentTurn.assistantMessage) {
        currentTurn.assistantMessage = msg;
        // Set mode on turn if not already set
        if (!currentTurn.mode && msg.mode) {
          currentTurn.mode = msg.mode;
        }
      } else {
        // Multiple assistant text messages in same turn - create new turn
        currentTurn.summary = computeToolSummary(currentTurn.toolEvents);
        turns.push(currentTurn);
        turnCounter++;
        currentTurn = {
          id: `turn-${turnCounter}`,
          assistantMessage: msg,
          toolEvents: [],
          summary: createEmptyToolSummary(),
          mode: msg.mode,  // Capture mode from assistant message
        };
      }
    } else if (category === 'event.tool') {
      // Tool event - attach to current turn or create orphan
      // Filter out system tools (EnterPlanMode, ExitPlanMode, AskFollowupQuestion)
      if (!isVisibleToolEvent(msg)) {
        continue;
      }

      if (!currentTurn) {
        turnCounter++;
        currentTurn = {
          id: `turn-${turnCounter}`,
          toolEvents: [],
          summary: createEmptyToolSummary(),
        };
      }
      currentTurn.toolEvents.push(msg);
    } else if (category === 'event.system') {
      // System events - they stay in their own "turn" for display
      // But we also continue grouping tool events before/after
      if (currentTurn && (currentTurn.userMessage || currentTurn.assistantMessage || currentTurn.toolEvents.length > 0)) {
        // There's content in current turn, finalize it first
        currentTurn.summary = computeToolSummary(currentTurn.toolEvents);
        turns.push(currentTurn);
        currentTurn = null;
      }
      // System message gets its own turn
      turnCounter++;
      turns.push({
        id: `turn-${turnCounter}`,
        assistantMessage: msg, // Use assistantMessage slot for display
        toolEvents: [],
        summary: createEmptyToolSummary(),
      });
    }
  }

  // Don't forget to push the last turn
  if (currentTurn) {
    currentTurn.summary = computeToolSummary(currentTurn.toolEvents);
    turns.push(currentTurn);
  }

  return turns;
}

/**
 * Check if a turn has any tool events to display
 */
export function turnHasToolEvents(turn: GroupedTurn): boolean {
  return turn.toolEvents.length > 0;
}

/**
 * Get total tool count from summary
 */
export function getTotalToolCount(summary: ToolSummary): number {
  return (
    summary.searches +
    summary.reads +
    summary.writes +
    summary.commands +
    summary.tasks +
    summary.other
  );
}
