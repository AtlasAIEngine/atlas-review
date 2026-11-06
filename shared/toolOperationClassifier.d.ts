export interface ToolOperationClassification {
  normalizedName: string;
  kind: 'write' | 'edit' | 'read' | 'shell' | 'reasoning' | 'unknown';
  fileAction: string;
  filePath: string | null;
  mutatesFiles: boolean;
  snapshotEligible: boolean;
  isReadOnly: boolean;
}

export function normalizeToolName(toolName: string | undefined | null): string;
export function extractToolPathFromToolInput(toolInput: unknown): string | null;
export function classifyToolOperation(toolName: string | undefined | null, toolInput?: unknown): ToolOperationClassification;
export function isFileMutationTool(toolName: string | undefined | null, toolInput?: unknown): boolean;
export function isSnapshotEligibleFileMutationTool(toolName: string | undefined | null, toolInput?: unknown): boolean;
