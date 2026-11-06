import type { ChatMode } from '@/types';

export type PendingProjectPrompt = {
  projectId: string;
  prompt: string;
  files: File[];
  chatMode: ChatMode;
  providerType: string | null;
  modelAlias: string | null;
  requestId: string;
};

function generatePendingPromptRequestId(): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createPendingProjectPrompt(
  projectId: string,
  prompt: string,
  files: File[] = [],
  options: {
    chatMode?: ChatMode;
    providerType?: string | null;
    modelAlias?: string | null;
  } = {},
): PendingProjectPrompt | null {
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    return null;
  }

  return {
    projectId,
    prompt: normalizedPrompt,
    files,
    chatMode: options.chatMode || 'agent',
    providerType: options.providerType || null,
    modelAlias: options.modelAlias || null,
    requestId: generatePendingPromptRequestId(),
  };
}
