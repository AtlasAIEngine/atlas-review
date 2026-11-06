export interface ChatRuntimeStatusSnapshot {
  active: boolean;
  hasStreamContent: boolean;
}

export function shouldApplyChatRecovery(
  recovery: { content?: string | null },
  runtimeStatus: ChatRuntimeStatusSnapshot,
): boolean {
  const hasRecoveryContent = Boolean(recovery.content && recovery.content.trim());
  return hasRecoveryContent || runtimeStatus.active || runtimeStatus.hasStreamContent;
}
