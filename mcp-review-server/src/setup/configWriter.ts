import fs from 'node:fs/promises';
import path from 'node:path';

import {
  generateAgentConfigOutput,
  renderTomlServerSection,
  type GenerateAgentConfigOptions,
  type JsonServerEntry,
  type McpServerEntry,
} from './configGenerator.js';
import { findTomlSectionRanges, validateTomlDocument } from './toml.js';

export interface WriteAgentConfigOptions extends GenerateAgentConfigOptions {
  agentId: string;
  dryRun?: boolean;
}

export interface WriteAgentConfigResult {
  agentId: string;
  agentDisplayName: string;
  format: 'json' | 'toml';
  configPath: string;
  serverName: string;
  changed: boolean;
  created: boolean;
  backupPath: string | null;
  dryRun: boolean;
  snippet: string;
  warnings: string[];
}

export interface RemoveAgentConfigOptions extends GenerateAgentConfigOptions {
  agentId: string;
  dryRun?: boolean;
}

export interface RemoveAgentConfigResult {
  agentId: string;
  agentDisplayName: string;
  format: 'json' | 'toml';
  configPath: string;
  serverName: string;
  changed: boolean;
  removed: boolean;
  backupPath: string | null;
  dryRun: boolean;
  warnings: string[];
}

interface ExistingFileResult {
  exists: boolean;
  raw: string;
}

const BACKUP_FILES_TO_KEEP = 5;

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

async function readExistingFile(filePath: string): Promise<ExistingFileResult> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return { exists: true, raw: normalizeLineEndings(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, raw: '' };
    }
    throw error;
  }
}

function mergeJsonConfig(
  raw: string,
  configPath: string,
  wrapperKey: string,
  serverName: string,
  serverEntry: JsonServerEntry
): { content: string; warnings: string[] } {
  let root: Record<string, unknown> = {};
  if (raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Config file at ${configPath} contains invalid JSON: ${message}. Please fix or back it up before running setup.`
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Config file at ${configPath} must contain a JSON object at root.`);
    }
    root = parsed as Record<string, unknown>;
  }

  const nextRoot: Record<string, unknown> = { ...root };
  const existingWrapper = nextRoot[wrapperKey];
  if (existingWrapper !== undefined && (!existingWrapper || typeof existingWrapper !== 'object' || Array.isArray(existingWrapper))) {
    throw new Error(
      `Config file at ${configPath} contains invalid JSON at "${wrapperKey}": expected an object wrapper for MCP entries.`
    );
  }
  const wrapperObject = existingWrapper && typeof existingWrapper === 'object' && !Array.isArray(existingWrapper)
    ? { ...(existingWrapper as Record<string, unknown>) }
    : {};

  wrapperObject[serverName] = serverEntry;
  nextRoot[wrapperKey] = wrapperObject;

  return {
    content: `${JSON.stringify(nextRoot, null, 2)}\n`,
    warnings: [],
  };
}

function removeJsonConfig(
  raw: string,
  configPath: string,
  wrapperKey: string,
  serverName: string
): { content: string; warnings: string[]; removed: boolean } {
  const warnings: string[] = [];
  if (!raw.trim()) {
    return { content: raw, warnings, removed: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Config file at ${configPath} contains invalid JSON: ${message}. Please fix or back it up before running setup.`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file at ${configPath} must contain a JSON object at root.`);
  }

  const nextRoot: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  const existingWrapper = nextRoot[wrapperKey];
  if (!existingWrapper || typeof existingWrapper !== 'object' || Array.isArray(existingWrapper)) {
    if (existingWrapper !== undefined) {
      throw new Error(
        `Config file at ${configPath} contains invalid JSON at "${wrapperKey}": expected an object wrapper for MCP entries.`
      );
    }
    return {
      content: `${JSON.stringify(nextRoot, null, 2)}\n`,
      warnings,
      removed: false,
    };
  }

  const wrapperObject = { ...(existingWrapper as Record<string, unknown>) };
  if (!Object.prototype.hasOwnProperty.call(wrapperObject, serverName)) {
    return {
      content: `${JSON.stringify(nextRoot, null, 2)}\n`,
      warnings,
      removed: false,
    };
  }

  delete wrapperObject[serverName];
  if (Object.keys(wrapperObject).length === 0) {
    delete nextRoot[wrapperKey];
  } else {
    nextRoot[wrapperKey] = wrapperObject;
  }
  return {
    content: `${JSON.stringify(nextRoot, null, 2)}\n`,
    warnings,
    removed: true,
  };
}

function isTargetTomlSection(sectionName: string, serverName: string): boolean {
  const target = `mcp_servers.${serverName}`;
  return sectionName === target || sectionName.startsWith(`${target}.`);
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1].trim() === '') {
    next.pop();
  }
  return next;
}

function mergeTomlConfig(
  raw: string,
  configPath: string,
  serverName: string,
  serverEntry: McpServerEntry
): { content: string; warnings: string[] } {
  const normalized = normalizeLineEndings(raw);
  validateTomlDocument(normalized, configPath);
  const lines = normalized.split('\n');
  const ranges = findTomlSectionRanges(normalized).filter((range) => isTargetTomlSection(range.name, serverName));
  const dropLineSet = new Set<number>();

  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      dropLineSet.add(line);
    }
  }

  const kept = trimTrailingBlankLines(lines.filter((_, index) => !dropLineSet.has(index)));
  const section = renderTomlServerSection(serverName, serverEntry);

  if (kept.length === 0) {
    return { content: `${section}\n`, warnings: [] };
  }
  return {
    content: `${kept.join('\n')}\n\n${section}\n`,
    warnings: [],
  };
}

function removeTomlConfig(
  raw: string,
  configPath: string,
  serverName: string
): { content: string; warnings: string[]; removed: boolean } {
  const normalized = normalizeLineEndings(raw);
  if (!normalized.trim()) {
    return { content: normalized, warnings: [], removed: false };
  }

  validateTomlDocument(normalized, configPath);
  const lines = normalized.split('\n');
  const ranges = findTomlSectionRanges(normalized).filter((range) => isTargetTomlSection(range.name, serverName));
  if (ranges.length === 0) {
    return { content: normalized, warnings: [], removed: false };
  }

  const dropLineSet = new Set<number>();
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      dropLineSet.add(line);
    }
  }
  const kept = trimTrailingBlankLines(lines.filter((_, index) => !dropLineSet.has(index)));
  const content = kept.length > 0 ? `${kept.join('\n')}\n` : '';
  return {
    content,
    warnings: [],
    removed: true,
  };
}

function getBackupPath(configPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${configPath}.${timestamp}.bak`;
}

function isBackupFileName(fileName: string, configFileName: string): boolean {
  return fileName.startsWith(`${configFileName}.`) && fileName.endsWith('.bak');
}

async function pruneOldBackups(configPath: string, keepCount = BACKUP_FILES_TO_KEEP): Promise<void> {
  const safeKeepCount = Math.max(1, Math.trunc(Number(keepCount) || BACKUP_FILES_TO_KEEP));
  const directory = path.dirname(configPath);
  const configFileName = path.basename(configPath);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return;
  }

  const backups = entries
    .filter((fileName) => isBackupFileName(fileName, configFileName))
    .sort();
  const removeCandidates = backups.slice(0, Math.max(0, backups.length - safeKeepCount));
  for (const fileName of removeCandidates) {
    await fs.rm(path.join(directory, fileName), { force: true }).catch(() => {});
  }
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  try {
    await fs.mkdir(directory, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare config directory for ${filePath}: ${message}`);
  }
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tempPath, content, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to write temporary config for ${filePath}: ${message}`);
  }
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to replace config file at ${filePath}: ${message}`);
  }
}

export async function writeAgentConfig(options: WriteAgentConfigOptions): Promise<WriteAgentConfigResult> {
  const output = await generateAgentConfigOutput(options.agentId, options);
  const existing = await readExistingFile(output.configPath);
  const wrapperKey = output.wrapperKey || 'mcpServers';
  const jsonServerEntry = output.jsonServerEntry || output.serverEntry;

  const merged = output.format === 'json'
    ? mergeJsonConfig(existing.raw, output.configPath, wrapperKey, output.serverName, jsonServerEntry)
    : mergeTomlConfig(existing.raw, output.configPath, output.serverName, output.serverEntry);
  const nextContent = merged.content;
  const warnings = merged.warnings;

  const changed = normalizeLineEndings(existing.raw) !== normalizeLineEndings(nextContent);
  const created = !existing.exists;

  if (!changed) {
    return {
      agentId: output.agent.id,
      agentDisplayName: output.agent.displayName,
      format: output.format,
      configPath: output.configPath,
      serverName: output.serverName,
      changed: false,
      created,
      backupPath: null,
      dryRun: !!options.dryRun,
      snippet: output.snippet,
      warnings,
    };
  }

  let backupPath: string | null = null;
  if (!options.dryRun) {
    if (existing.exists) {
      backupPath = getBackupPath(output.configPath);
      try {
        await fs.copyFile(output.configPath, backupPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to create backup for ${output.configPath}: ${message}`);
      }
    }
    await writeFileAtomic(output.configPath, nextContent);
    if (backupPath) {
      await pruneOldBackups(output.configPath);
    }
  }

  return {
    agentId: output.agent.id,
    agentDisplayName: output.agent.displayName,
    format: output.format,
    configPath: output.configPath,
    serverName: output.serverName,
    changed: true,
    created,
    backupPath,
    dryRun: !!options.dryRun,
    snippet: output.snippet,
    warnings,
  };
}

export async function removeAgentConfig(options: RemoveAgentConfigOptions): Promise<RemoveAgentConfigResult> {
  const output = await generateAgentConfigOutput(options.agentId, options);
  const existing = await readExistingFile(output.configPath);
  const wrapperKey = output.wrapperKey || 'mcpServers';

  if (!existing.exists) {
    return {
      agentId: output.agent.id,
      agentDisplayName: output.agent.displayName,
      format: output.format,
      configPath: output.configPath,
      serverName: output.serverName,
      changed: false,
      removed: false,
      backupPath: null,
      dryRun: !!options.dryRun,
      warnings: [],
    };
  }

  const removedResult = output.format === 'json'
    ? removeJsonConfig(existing.raw, output.configPath, wrapperKey, output.serverName)
    : removeTomlConfig(existing.raw, output.configPath, output.serverName);
  const nextContent = removedResult.content;
  const warnings = removedResult.warnings;
  const removed = removedResult.removed;
  const changed = normalizeLineEndings(existing.raw) !== normalizeLineEndings(nextContent);

  if (!changed) {
    return {
      agentId: output.agent.id,
      agentDisplayName: output.agent.displayName,
      format: output.format,
      configPath: output.configPath,
      serverName: output.serverName,
      changed: false,
      removed: false,
      backupPath: null,
      dryRun: !!options.dryRun,
      warnings,
    };
  }

  let backupPath: string | null = null;
  if (!options.dryRun) {
    backupPath = getBackupPath(output.configPath);
    try {
      await fs.copyFile(output.configPath, backupPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create backup for ${output.configPath}: ${message}`);
    }
    await writeFileAtomic(output.configPath, nextContent);
    await pruneOldBackups(output.configPath);
  }

  return {
    agentId: output.agent.id,
    agentDisplayName: output.agent.displayName,
    format: output.format,
    configPath: output.configPath,
    serverName: output.serverName,
    changed: true,
    removed,
    backupPath,
    dryRun: !!options.dryRun,
    warnings,
  };
}
