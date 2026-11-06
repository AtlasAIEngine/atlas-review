import fs from 'fs/promises';
import path from 'path';
import {
  ATLAS_AGENT_INSTRUCTION_BLOCK_END,
  ATLAS_AGENT_INSTRUCTION_BLOCK_START,
  renderAtlasInstructionBlock,
  resolveInstructionTarget,
} from './agentInstructionTemplate.js';

function assertProjectRoot(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new Error('Project path is required.');
  }
  return path.resolve(projectPath);
}

export function resolveInstructionFilePath(projectPath, relativeFilePath) {
  const resolvedProjectPath = assertProjectRoot(projectPath);
  if (typeof relativeFilePath !== 'string' || !relativeFilePath.trim()) {
    throw new Error('Instruction file path is required.');
  }

  const absolutePath = path.resolve(resolvedProjectPath, relativeFilePath);
  const relative = path.relative(resolvedProjectPath, absolutePath);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return absolutePath;
  }

  throw new Error(`Resolved path escapes project root: ${relativeFilePath}`);
}

export function normalizeInstructionTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('At least one instruction target is required.');
  }

  const seenIds = new Set();
  const seenFilePaths = new Set();
  const normalizedTargets = [];
  for (const target of targets) {
    const resolved = resolveInstructionTarget(target);
    if (!resolved) {
      throw new Error(`Unsupported instruction target: ${String(target)}`);
    }
    if (seenIds.has(resolved.id) || seenFilePaths.has(resolved.filePath)) continue;
    seenIds.add(resolved.id);
    seenFilePaths.add(resolved.filePath);
    normalizedTargets.push(resolved);
  }
  return normalizedTargets;
}

export function replaceAtlasInstructionBlock(existingContent, instructionBlock) {
  const normalizedExisting = typeof existingContent === 'string' ? existingContent : '';
  const firstBlockRegex = new RegExp(
    `${escapeRegex(ATLAS_AGENT_INSTRUCTION_BLOCK_START)}[\\s\\S]*?${escapeRegex(ATLAS_AGENT_INSTRUCTION_BLOCK_END)}\\s*`,
  );
  const allBlocksRegex = new RegExp(
    `${escapeRegex(ATLAS_AGENT_INSTRUCTION_BLOCK_START)}[\\s\\S]*?${escapeRegex(ATLAS_AGENT_INSTRUCTION_BLOCK_END)}\\s*`,
    'g'
  );

  const firstMatch = normalizedExisting.match(firstBlockRegex);
  if (firstMatch && typeof firstMatch.index === 'number') {
    const beforeFirstBlock = normalizedExisting.slice(0, firstMatch.index);
    const afterFirstBlock = normalizedExisting
      .slice(firstMatch.index + firstMatch[0].length)
      .replace(allBlocksRegex, '');
    return normalizeDocumentWhitespace(`${beforeFirstBlock}${instructionBlock}\n${afterFirstBlock}`);
  }

  const trimmed = normalizedExisting.trimEnd();
  if (!trimmed) {
    return `${instructionBlock}\n`;
  }
  return `${trimmed}\n\n${instructionBlock}\n`;
}

export function removeAtlasInstructionBlock(existingContent) {
  const normalizedExisting = typeof existingContent === 'string' ? existingContent : '';
  const blockRegex = new RegExp(
    `\\s*${escapeRegex(ATLAS_AGENT_INSTRUCTION_BLOCK_START)}[\\s\\S]*?${escapeRegex(ATLAS_AGENT_INSTRUCTION_BLOCK_END)}\\s*`,
    'g'
  );

  if (!blockRegex.test(normalizedExisting)) {
    return {
      changed: false,
      content: normalizedExisting,
    };
  }

  const removed = normalizedExisting.replace(blockRegex, '\n');
  return {
    changed: true,
    content: normalizeDocumentWhitespace(removed),
  };
}

export async function previewInstructions({ projectPath, targets }) {
  const resolvedProjectPath = assertProjectRoot(projectPath);
  const normalizedTargets = normalizeInstructionTargets(targets);
  const instructionBlock = renderAtlasInstructionBlock();

  return {
    instructionBlock,
    previews: normalizedTargets.map((target) => ({
      target: target.id,
      label: target.label,
      filePath: resolveInstructionFilePath(resolvedProjectPath, target.filePath),
      relativeFilePath: target.filePath,
      content: instructionBlock,
    })),
  };
}

export async function writeInstructions({ projectPath, targets, dryRun = false }) {
  const resolvedProjectPath = assertProjectRoot(projectPath);
  const normalizedTargets = normalizeInstructionTargets(targets);
  const instructionBlock = renderAtlasInstructionBlock();
  const results = [];
  const failures = [];

  for (const target of normalizedTargets) {
    try {
      const absolutePath = resolveInstructionFilePath(resolvedProjectPath, target.filePath);
      const existing = await readFileIfExists(absolutePath);
      const nextContent = replaceAtlasInstructionBlock(existing, instructionBlock);
      const changed = nextContent !== (existing ?? '');
      const created = existing == null;
      if (changed && !dryRun) {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, nextContent, 'utf8');
      }

      results.push({
        target: target.id,
        label: target.label,
        filePath: absolutePath,
        relativeFilePath: target.filePath,
        changed,
        created,
        backupPath: null,
        dryRun: Boolean(dryRun),
      });
    } catch (error) {
      failures.push({
        target: target.id,
        label: target.label,
        filePath: target.filePath,
        error: String(error?.message || error || 'Unknown error'),
      });
    }
  }

  return {
    instructionBlock,
    results,
    failures,
  };
}

export async function removeInstructions({ projectPath, targets, dryRun = false }) {
  const resolvedProjectPath = assertProjectRoot(projectPath);
  const normalizedTargets = normalizeInstructionTargets(targets);
  const results = [];
  const failures = [];

  for (const target of normalizedTargets) {
    try {
      const absolutePath = resolveInstructionFilePath(resolvedProjectPath, target.filePath);
      const existing = await readFileIfExists(absolutePath);
      const removal = removeAtlasInstructionBlock(existing);
      if (removal.changed && !dryRun) {
        if (removal.content.trim()) {
          await fs.writeFile(absolutePath, removal.content, 'utf8');
        } else {
          await fs.rm(absolutePath, { force: true });
        }
      }

      results.push({
        target: target.id,
        label: target.label,
        filePath: absolutePath,
        relativeFilePath: target.filePath,
        changed: removal.changed,
        removed: removal.changed,
        backupPath: null,
        dryRun: Boolean(dryRun),
      });
    } catch (error) {
      failures.push({
        target: target.id,
        label: target.label,
        filePath: target.filePath,
        error: String(error?.message || error || 'Unknown error'),
      });
    }
  }

  return {
    results,
    failures,
  };
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeDocumentWhitespace(content) {
  const normalized = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized ? `${normalized}\n` : '';
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  previewInstructions,
  writeInstructions,
  removeInstructions,
  normalizeInstructionTargets,
  replaceAtlasInstructionBlock,
  removeAtlasInstructionBlock,
  resolveInstructionFilePath,
};
