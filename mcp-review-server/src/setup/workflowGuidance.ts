import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AgentPathContext, AgentWorkflowGuidance, AgentWorkflowGuidanceState } from './agentRegistry.js';
import { writeFileAtomic } from './configWriter.js';

const CODEX_GLOBAL_SKILL_NAME = 'atlas-review-global';
const CODEX_GLOBAL_SKILL_MARKER = 'Atlas Review Global Guidance';
const OPENCODE_GLOBAL_SKILL_MARKER = 'Atlas Review Global Guidance for OpenCode';
const CLAUDE_GLOBAL_GUIDANCE_MARKER_START = '<!-- atlas-review-global:start -->';
const CLAUDE_GLOBAL_GUIDANCE_MARKER_END = '<!-- atlas-review-global:end -->';

const SHARED_WORKFLOW_BODY = `Use Atlas MCP when:
- the user explicitly asks for Atlas review, Atlas MCP, or Atlas-backed issue finding
- the user asks to validate, fix, address, dismiss, or persist existing Atlas findings

Do not trigger Atlas by default for generic review prompts like "review this", "find issues", or "assess risk" unless repo-local guidance expands that behavior. Do not use Atlas MCP just because code changes are complete or local checks passed.

Recommended workflow:
1. Inspect current Atlas review context with atlas://review/current or atlas_review_status
2. Run atlas_review_run_current when no completed review exists for the target
3. Wait with atlas_review_wait_for_terminal while the review is active
4. Read findings with atlas_review_latest
5. Inspect specific files with atlas_review_file when needed
6. Persist addressed or dismissed findings with atlas_review_outcome_set
7. Verify persisted outcomes with atlas_review_outcome_get or atlas_review_latest before concluding

Rules:
- Do not cancel a running review based on elapsed time alone
- Omit projectId unless you know the exact Atlas backend project id; do not guess projectId from the repository or directory name
- Use explicit PR targeting for PR review requests
- Do not claim a finding is fixed until the outcome has been persisted`;

function buildCodexWorkflowSkillContent(): string {
  return `---
name: ${CODEX_GLOBAL_SKILL_NAME}
description: Use Atlas MCP for Atlas-named review requests and persist findings outcomes before concluding.
---

# ${CODEX_GLOBAL_SKILL_MARKER}

${SHARED_WORKFLOW_BODY}
`;
}

function buildOpenCodeWorkflowSkillContent(): string {
  return `---
name: ${CODEX_GLOBAL_SKILL_NAME}
description: Use Atlas MCP for Atlas-named review requests and persist findings outcomes before concluding.
compatibility: opencode
---

# ${OPENCODE_GLOBAL_SKILL_MARKER}

${SHARED_WORKFLOW_BODY}
`;
}

function buildClaudeWorkflowGuidanceBlock(): string {
  return `${CLAUDE_GLOBAL_GUIDANCE_MARKER_START}
## Atlas Review (Global)

${SHARED_WORKFLOW_BODY}
${CLAUDE_GLOBAL_GUIDANCE_MARKER_END}
`;
}

function buildCodexWorkflowGuidance(): AgentWorkflowGuidance {
  return {
    strategyId: 'codex_global_skill',
    title: 'Global Codex Skill',
    defaultSummary: 'Atlas-managed global guidance is the default path for Codex. Setup sync writes MCP config and keeps the canonical global Atlas skill in sync for you.',
    installSummary: 'Selecting Codex in Atlas MCP setup applies the full managed global bundle: MCP registration plus the canonical `atlas-review-global` skill.',
    installSteps: [
      'Select Codex in Atlas MCP setup or run the shipped `setup --auto` / `setup --agent=codex` path.',
      `Atlas writes the Codex MCP config and installs or refreshes the managed skill at \`${CODEX_GLOBAL_SKILL_NAME}\`.`,
      'If you need break-glass manual control, copy the skill snippet below into the canonical Codex skills directory yourself.',
    ],
    snippetLabel: 'Global skill content',
    snippet: buildCodexWorkflowSkillContent(),
    overrideSummary: 'Repo-local `AGENTS.md` guidance remains available only as a project-level override when a team wants behavior that differs from the managed global default.',
    fallbackSummary: 'If the managed global skill cannot be installed or verified, use the snippet as a temporary manual fallback. If a specific repo still needs different behavior, add the repo-local `AGENTS.md` Atlas block for that repo only.',
  };
}

function buildClaudeWorkflowGuidance(): AgentWorkflowGuidance {
  return {
    strategyId: 'claude_global_guidance',
    title: 'Global Claude Guidance',
    defaultSummary: 'Atlas-managed global guidance is the default path for Claude Code. Setup sync manages the Claude MCP config and the Atlas block in `~/.claude/CLAUDE.md` together.',
    installSummary: 'Selecting Claude Code in Atlas MCP setup applies the managed global bundle: MCP registration plus the Atlas-managed guidance block in `~/.claude/CLAUDE.md`.',
    installSteps: [
      'Select Claude Code in the MCP setup screen or Settings > MCP and sync your selection.',
      'Atlas installs or updates the managed Atlas block in `~/.claude/CLAUDE.md` automatically.',
      'If you need break-glass manual control, copy the block below into `~/.claude/CLAUDE.md` yourself.',
    ],
    snippetLabel: 'Global guidance block',
    snippet: buildClaudeWorkflowGuidanceBlock(),
    overrideSummary: 'Repo-local `CLAUDE.md` guidance remains available only as a project-level override when a repo needs workflow behavior that differs from the Atlas-managed global default.',
    fallbackSummary: 'If the managed `~/.claude/CLAUDE.md` block cannot be installed or verified, use the snippet as a temporary manual fallback. If one repository still needs different behavior, add the repo-local `CLAUDE.md` Atlas block for that repo only.',
  };
}

function buildOpenCodeWorkflowGuidance(): AgentWorkflowGuidance {
  return {
    strategyId: 'opencode_global_skill',
    title: 'Global OpenCode Skill',
    defaultSummary: 'Atlas-managed global guidance is the default path for OpenCode. Setup sync manages the OpenCode MCP config and the canonical global Atlas skill together.',
    installSummary: 'Selecting OpenCode in Atlas MCP setup applies the managed global bundle: MCP registration in `~/.config/opencode/opencode.json` plus the canonical `atlas-review-global` skill.',
    installSteps: [
      'Select OpenCode in Atlas MCP setup or run the shipped `setup --agent=opencode` path.',
      `Atlas writes the OpenCode MCP config and installs or refreshes the managed skill at \`${CODEX_GLOBAL_SKILL_NAME}\` in the global OpenCode skills directory.`,
      'If you need break-glass manual control, copy the skill snippet below into the canonical OpenCode skills directory yourself.',
    ],
    snippetLabel: 'Global skill content',
    snippet: buildOpenCodeWorkflowSkillContent(),
    overrideSummary: 'Repo-local `AGENTS.md` guidance remains available only as a project-level override when a team wants behavior that differs from the managed global default.',
    fallbackSummary: 'If the managed global OpenCode skill cannot be installed or verified, use the snippet as a temporary manual fallback. If a specific repo still needs different behavior, add the repo-local `AGENTS.md` Atlas block for that repo only.',
  };
}

export function buildAgentWorkflowGuidance(agentId: string): AgentWorkflowGuidance | null {
  if (agentId === 'codex') {
    return buildCodexWorkflowGuidance();
  }
  if (agentId === 'opencode') {
    return buildOpenCodeWorkflowGuidance();
  }
  if (agentId === 'claude-code') {
    return buildClaudeWorkflowGuidance();
  }
  return null;
}

export function supportsManagedWorkflowGuidance(agentId: string): boolean {
  return buildAgentWorkflowGuidance(agentId) !== null;
}

export function buildAgentWorkflowGuidanceState(agentId: string): AgentWorkflowGuidanceState {
  if (agentId === 'codex' || agentId === 'claude-code' || agentId === 'opencode') {
    return {
      status: 'not_installed',
      label: 'Managed global default available',
      summary: 'Atlas can manage the global workflow guidance for this agent during MCP setup sync. Repo-local instructions remain available as project-level overrides, not the default onboarding path.',
      detectedPath: null,
    };
  }

  return {
    status: 'not_supported',
    label: 'No global workflow path',
    summary: 'Atlas does not currently ship a dedicated global workflow-guidance path for this agent.',
    detectedPath: null,
  };
}

function resolveCodexSkillsRoot(context: AgentPathContext = {}): string {
  const fallbackHomeDir = process.env.HOME || os.homedir();
  const contextHomeDir = String(context.homeDir || '').trim();
  const codexHome = String(process.env.CODEX_HOME || '').trim();
  const normalizedFallbackHomeDir = path.resolve(fallbackHomeDir);
  const normalizedContextHomeDir = contextHomeDir ? path.resolve(contextHomeDir) : '';
  // Honor CODEX_HOME in normal runtime resolution, but keep explicit test/runtime overrides working.
  if (codexHome && (!normalizedContextHomeDir || normalizedContextHomeDir === normalizedFallbackHomeDir)) {
    return path.join(codexHome, 'skills');
  }
  if (normalizedContextHomeDir) {
    return path.join(normalizedContextHomeDir, '.codex', 'skills');
  }
  return path.join(normalizedFallbackHomeDir, '.codex', 'skills');
}

function resolveCodexWorkflowGuidancePath(context: AgentPathContext = {}): string {
  return path.join(resolveCodexSkillsRoot(context), CODEX_GLOBAL_SKILL_NAME, 'SKILL.md');
}

function resolveOpenCodeSkillsRoot(context: AgentPathContext = {}): string {
  const homeDir = context.homeDir || process.env.HOME || os.homedir();
  return path.join(homeDir, '.config', 'opencode', 'skills');
}

function resolveOpenCodeWorkflowGuidancePath(context: AgentPathContext = {}): string {
  return path.join(resolveOpenCodeSkillsRoot(context), CODEX_GLOBAL_SKILL_NAME, 'SKILL.md');
}

function resolveClaudeWorkflowGuidancePath(context: AgentPathContext = {}): string {
  const homeDir = context.homeDir || process.env.HOME || os.homedir();
  return path.join(homeDir, '.claude', 'CLAUDE.md');
}

async function resolveCodexWorkflowGuidanceState(context: AgentPathContext = {}): Promise<AgentWorkflowGuidanceState> {
  const skillPath = resolveCodexWorkflowGuidancePath(context);
  try {
    const content = await fs.readFile(skillPath, 'utf8');
    const hasExpectedMarkers = content.includes(`name: ${CODEX_GLOBAL_SKILL_NAME}`)
      && content.includes(CODEX_GLOBAL_SKILL_MARKER);
    if (hasExpectedMarkers) {
      return {
        status: 'installed',
        label: 'Managed global default active',
        summary: `Detected the Atlas-managed global Codex skill at ${skillPath}. Repo-local AGENTS guidance, if added later, should be treated as a project-level override.`,
        detectedPath: skillPath,
      };
    }
    return {
      status: 'manual_install_required',
      label: 'Manual cleanup required',
      summary: `Found ${skillPath}, but it does not match the expected Atlas-managed global skill markers. Resolve or remove the conflicting skill before Atlas can manage the global default path again.`,
      detectedPath: skillPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        status: 'not_installed',
        label: 'Managed global default available',
        summary: `Atlas did not find the canonical global Codex skill at ${skillPath}. Setup sync can install it as the default path; repo-local AGENTS guidance remains an override only.`,
        detectedPath: skillPath,
      };
    }
    return {
      status: 'manual_install_required',
      label: 'Manual cleanup required',
      summary: `Atlas could not inspect the global Codex skill at ${skillPath}: ${error instanceof Error ? error.message : String(error)}`,
      detectedPath: skillPath,
    };
  }
}

async function resolveOpenCodeWorkflowGuidanceState(context: AgentPathContext = {}): Promise<AgentWorkflowGuidanceState> {
  const skillPath = resolveOpenCodeWorkflowGuidancePath(context);
  try {
    const content = await fs.readFile(skillPath, 'utf8');
    const hasExpectedMarkers = content.includes(`name: ${CODEX_GLOBAL_SKILL_NAME}`)
      && content.includes(OPENCODE_GLOBAL_SKILL_MARKER);
    if (hasExpectedMarkers) {
      return {
        status: 'installed',
        label: 'Managed global default active',
        summary: `Detected the Atlas-managed global OpenCode skill at ${skillPath}. Repo-local AGENTS guidance, if added later, should be treated as a project-level override.`,
        detectedPath: skillPath,
      };
    }
    return {
      status: 'manual_install_required',
      label: 'Manual cleanup required',
      summary: `Found ${skillPath}, but it does not match the expected Atlas-managed global OpenCode skill markers. Resolve or remove the conflicting skill before Atlas can manage the global default path again.`,
      detectedPath: skillPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        status: 'not_installed',
        label: 'Managed global default available',
        summary: `Atlas did not find the canonical global OpenCode skill at ${skillPath}. Setup sync can install it as the default path; repo-local AGENTS guidance remains an override only.`,
        detectedPath: skillPath,
      };
    }
    return {
      status: 'manual_install_required',
      label: 'Manual cleanup required',
      summary: `Atlas could not inspect the global OpenCode skill at ${skillPath}: ${error instanceof Error ? error.message : String(error)}`,
      detectedPath: skillPath,
    };
  }
}

function findManagedBlockRange(content: string): { start: number; end: number } | null {
  const start = content.indexOf(CLAUDE_GLOBAL_GUIDANCE_MARKER_START);
  const end = content.indexOf(CLAUDE_GLOBAL_GUIDANCE_MARKER_END);
  if (start === -1 && end === -1) {
    return null;
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Found an incomplete Atlas-managed Claude guidance block. Resolve the markers in ~/.claude/CLAUDE.md before Atlas can continue.');
  }
  return {
    start,
    end: end + CLAUDE_GLOBAL_GUIDANCE_MARKER_END.length,
  };
}

async function resolveClaudeWorkflowGuidanceState(context: AgentPathContext = {}): Promise<AgentWorkflowGuidanceState> {
  const filePath = resolveClaudeWorkflowGuidancePath(context);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const range = findManagedBlockRange(content);
    if (!range) {
      return {
        status: 'not_installed',
        label: 'Managed global default available',
        summary: `Atlas did not find the managed Claude guidance block in ${filePath}. Setup sync can install it as the default path; repo-local CLAUDE guidance remains a project-level override.`,
        detectedPath: filePath,
      };
    }
    return {
      status: 'installed',
      label: 'Managed global default active',
      summary: `Detected the Atlas-managed Claude guidance block in ${filePath}. Repo-local CLAUDE guidance, if added later, should be treated as a project-level override.`,
      detectedPath: filePath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        status: 'not_installed',
        label: 'Managed global default available',
        summary: `Atlas did not find the Claude global guidance file at ${filePath}. Setup sync can create it as the default path; repo-local CLAUDE guidance remains a project-level override.`,
        detectedPath: filePath,
      };
    }
    if (error instanceof Error && /incomplete Atlas-managed Claude guidance block/u.test(error.message)) {
      return {
        status: 'manual_install_required',
        label: 'Manual cleanup required',
        summary: error.message,
        detectedPath: filePath,
      };
    }
    return {
      status: 'manual_install_required',
      label: 'Manual cleanup required',
      summary: `Atlas could not inspect the Claude global guidance file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      detectedPath: filePath,
    };
  }
}

export async function resolveAgentWorkflowGuidanceState(
  agentId: string,
  context: AgentPathContext = {},
): Promise<AgentWorkflowGuidanceState> {
  if (agentId === 'codex') {
    return resolveCodexWorkflowGuidanceState(context);
  }
  if (agentId === 'opencode') {
    return resolveOpenCodeWorkflowGuidanceState(context);
  }
  if (agentId === 'claude-code') {
    return resolveClaudeWorkflowGuidanceState(context);
  }
  return buildAgentWorkflowGuidanceState(agentId);
}

export interface InstallAgentWorkflowGuidanceOptions extends AgentPathContext {
  dryRun?: boolean;
}

export interface InstallAgentWorkflowGuidanceResult {
  agentId: string;
  changed: boolean;
  dryRun: boolean;
  targetPath: string;
  statusBefore: AgentWorkflowGuidanceState;
  statusAfter: AgentWorkflowGuidanceState;
}

async function installCodexWorkflowGuidance(
  context: InstallAgentWorkflowGuidanceOptions = {},
): Promise<InstallAgentWorkflowGuidanceResult> {
  const targetPath = resolveCodexWorkflowGuidancePath(context);
  const dryRun = context.dryRun === true;
  const statusBefore = await resolveCodexWorkflowGuidanceState(context);
  const expectedContent = buildCodexWorkflowSkillContent();
  let changed = false;

  try {
    const existing = await fs.readFile(targetPath, 'utf8');
    if (existing === expectedContent) {
      return {
        agentId: 'codex',
        changed: false,
        dryRun,
        targetPath,
        statusBefore,
        statusAfter: {
          status: 'installed',
          label: 'Managed global default active',
          summary: `Detected the Atlas-managed global Codex skill at ${targetPath}. Repo-local AGENTS guidance, if added later, should be treated as a project-level override.`,
          detectedPath: targetPath,
        },
      };
    }

    const hasAtlasMarkers = existing.includes(`name: ${CODEX_GLOBAL_SKILL_NAME}`)
      || existing.includes(CODEX_GLOBAL_SKILL_MARKER);
    if (!hasAtlasMarkers) {
      throw new Error(`Refusing to overwrite a non-Atlas skill at ${targetPath}. Remove it manually or install the Atlas guidance to a different location.`);
    }
    changed = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      throw error;
    }
    changed = true;
  }

  if (!dryRun) {
    await writeFileAtomic(targetPath, expectedContent);
  }

  return {
    agentId: 'codex',
    changed,
    dryRun,
    targetPath,
    statusBefore,
    statusAfter: {
      status: 'installed',
      label: 'Managed global default active',
      summary: dryRun
        ? `Atlas would install the Atlas-managed global Codex skill at ${targetPath}. Repo-local AGENTS guidance would remain a project-level override.`
        : `Detected the Atlas-managed global Codex skill at ${targetPath}. Repo-local AGENTS guidance, if added later, should be treated as a project-level override.`,
      detectedPath: targetPath,
    },
  };
}

async function installOpenCodeWorkflowGuidance(
  context: InstallAgentWorkflowGuidanceOptions = {},
): Promise<InstallAgentWorkflowGuidanceResult> {
  const targetPath = resolveOpenCodeWorkflowGuidancePath(context);
  const dryRun = context.dryRun === true;
  const statusBefore = await resolveOpenCodeWorkflowGuidanceState(context);
  const expectedContent = buildOpenCodeWorkflowSkillContent();
  let changed = false;

  try {
    const existing = await fs.readFile(targetPath, 'utf8');
    if (existing === expectedContent) {
      return {
        agentId: 'opencode',
        changed: false,
        dryRun,
        targetPath,
        statusBefore,
        statusAfter: {
          status: 'installed',
          label: 'Managed global default active',
          summary: `Detected the Atlas-managed global OpenCode skill at ${targetPath}. Repo-local AGENTS guidance, if added later, should be treated as a project-level override.`,
          detectedPath: targetPath,
        },
      };
    }

    const hasAtlasMarkers = existing.includes(`name: ${CODEX_GLOBAL_SKILL_NAME}`)
      && existing.includes(OPENCODE_GLOBAL_SKILL_MARKER);
    if (!hasAtlasMarkers) {
      throw new Error(`Refusing to overwrite a non-Atlas skill at ${targetPath}. Remove it manually or install the Atlas guidance to a different location.`);
    }
    changed = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      throw error;
    }
    changed = true;
  }

  if (!dryRun) {
    await writeFileAtomic(targetPath, expectedContent);
  }

  return {
    agentId: 'opencode',
    changed,
    dryRun,
    targetPath,
    statusBefore,
    statusAfter: {
      status: 'installed',
      label: 'Managed global default active',
      summary: dryRun
        ? `Atlas would install the Atlas-managed global OpenCode skill at ${targetPath}. Repo-local AGENTS guidance would remain a project-level override.`
        : `Detected the Atlas-managed global OpenCode skill at ${targetPath}. Repo-local AGENTS guidance, if added later, should be treated as a project-level override.`,
      detectedPath: targetPath,
    },
  };
}

async function installClaudeWorkflowGuidance(
  context: InstallAgentWorkflowGuidanceOptions = {},
): Promise<InstallAgentWorkflowGuidanceResult> {
  const targetPath = resolveClaudeWorkflowGuidancePath(context);
  const dryRun = context.dryRun === true;
  const statusBefore = await resolveClaudeWorkflowGuidanceState(context);
  const expectedBlock = buildClaudeWorkflowGuidanceBlock();
  let existing = '';
  let nextContent = expectedBlock;

  try {
    existing = await fs.readFile(targetPath, 'utf8');
    const range = findManagedBlockRange(existing);
    if (range) {
      const currentBlock = existing.slice(range.start, range.end);
      if (currentBlock === expectedBlock) {
        return {
          agentId: 'claude-code',
          changed: false,
          dryRun,
          targetPath,
          statusBefore,
          statusAfter: {
            status: 'installed',
            label: 'Managed global default active',
            summary: `Detected the Atlas-managed Claude guidance block in ${targetPath}. Repo-local CLAUDE guidance, if added later, should be treated as a project-level override.`,
            detectedPath: targetPath,
          },
        };
      }
      nextContent = `${existing.slice(0, range.start)}${expectedBlock}${existing.slice(range.end)}`;
    } else {
      const trimmed = existing.replace(/\s+$/u, '');
      nextContent = trimmed ? `${trimmed}\n\n${expectedBlock}\n` : `${expectedBlock}\n`;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  if (!dryRun) {
    await writeFileAtomic(targetPath, nextContent);
  }

  return {
    agentId: 'claude-code',
    changed: true,
    dryRun,
    targetPath,
    statusBefore,
    statusAfter: {
      status: 'installed',
      label: 'Managed global default active',
      summary: dryRun
        ? `Atlas would install the Atlas-managed Claude guidance block in ${targetPath}. Repo-local CLAUDE guidance would remain a project-level override.`
        : `Detected the Atlas-managed Claude guidance block in ${targetPath}. Repo-local CLAUDE guidance, if added later, should be treated as a project-level override.`,
      detectedPath: targetPath,
    },
  };
}

export interface RemoveAgentWorkflowGuidanceOptions extends AgentPathContext {
  dryRun?: boolean;
}

export interface RemoveAgentWorkflowGuidanceResult {
  agentId: string;
  changed: boolean;
  dryRun: boolean;
  targetPath: string;
  statusBefore: AgentWorkflowGuidanceState;
  statusAfter: AgentWorkflowGuidanceState;
}

async function removeCodexWorkflowGuidance(
  context: RemoveAgentWorkflowGuidanceOptions = {},
): Promise<RemoveAgentWorkflowGuidanceResult> {
  const targetPath = resolveCodexWorkflowGuidancePath(context);
  const dryRun = context.dryRun === true;
  const statusBefore = await resolveCodexWorkflowGuidanceState(context);
  try {
    const existing = await fs.readFile(targetPath, 'utf8');
    const hasAtlasMarkers = existing.includes(`name: ${CODEX_GLOBAL_SKILL_NAME}`)
      && existing.includes(CODEX_GLOBAL_SKILL_MARKER);
    if (!hasAtlasMarkers) {
      return {
        agentId: 'codex',
        changed: false,
        dryRun,
        targetPath,
        statusBefore,
        statusAfter: statusBefore,
      };
    }
    if (!dryRun) {
      await fs.unlink(targetPath);
    }
    return {
      agentId: 'codex',
      changed: true,
      dryRun,
      targetPath,
      statusBefore,
      statusAfter: {
        status: 'not_installed',
        label: 'Managed global default available',
        summary: `Atlas did not find the canonical global Codex skill at ${targetPath}. Setup sync can install it as the default path; repo-local AGENTS guidance remains an override only.`,
        detectedPath: targetPath,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      const statusAfter = await resolveCodexWorkflowGuidanceState(context);
      return {
        agentId: 'codex',
        changed: false,
        dryRun,
        targetPath,
        statusBefore,
        statusAfter,
      };
    }
    throw error;
  }
}

async function removeOpenCodeWorkflowGuidance(
  context: RemoveAgentWorkflowGuidanceOptions = {},
): Promise<RemoveAgentWorkflowGuidanceResult> {
  const targetPath = resolveOpenCodeWorkflowGuidancePath(context);
  const dryRun = context.dryRun === true;
  const statusBefore = await resolveOpenCodeWorkflowGuidanceState(context);
  try {
    const existing = await fs.readFile(targetPath, 'utf8');
    const hasAtlasMarkers = existing.includes(`name: ${CODEX_GLOBAL_SKILL_NAME}`)
      && existing.includes(OPENCODE_GLOBAL_SKILL_MARKER);
    if (!hasAtlasMarkers) {
      return {
        agentId: 'opencode',
        changed: false,
        dryRun,
        targetPath,
        statusBefore,
        statusAfter: statusBefore,
      };
    }
    if (!dryRun) {
      await fs.unlink(targetPath);
    }
    return {
      agentId: 'opencode',
      changed: true,
      dryRun,
      targetPath,
      statusBefore,
      statusAfter: {
        status: 'not_installed',
        label: 'Managed global default available',
        summary: `Atlas did not find the canonical global OpenCode skill at ${targetPath}. Setup sync can install it as the default path; repo-local AGENTS guidance remains an override only.`,
        detectedPath: targetPath,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      const statusAfter = await resolveOpenCodeWorkflowGuidanceState(context);
      return {
        agentId: 'opencode',
        changed: false,
        dryRun,
        targetPath,
        statusBefore,
        statusAfter,
      };
    }
    throw error;
  }
}

async function removeClaudeWorkflowGuidance(
  context: RemoveAgentWorkflowGuidanceOptions = {},
): Promise<RemoveAgentWorkflowGuidanceResult> {
  const targetPath = resolveClaudeWorkflowGuidancePath(context);
  const dryRun = context.dryRun === true;
  const statusBefore = await resolveClaudeWorkflowGuidanceState(context);
  try {
    const existing = await fs.readFile(targetPath, 'utf8');
    const range = findManagedBlockRange(existing);
    if (!range) {
      return {
        agentId: 'claude-code',
        changed: false,
        dryRun,
        targetPath,
        statusBefore,
        statusAfter: statusBefore,
      };
    }
    const before = existing.slice(0, range.start).replace(/\s+$/u, '');
    const after = existing.slice(range.end).replace(/^\s+/u, '');
    const nextContent = before && after
      ? `${before}\n\n${after}`
      : before || after;
    if (!dryRun) {
      if (nextContent) {
        await writeFileAtomic(targetPath, `${nextContent}\n`);
      } else {
        await fs.unlink(targetPath);
      }
    }
    return {
      agentId: 'claude-code',
      changed: true,
      dryRun,
      targetPath,
      statusBefore,
      statusAfter: {
        status: 'not_installed',
        label: 'Managed global default available',
        summary: `Atlas did not find the managed Claude guidance block in ${targetPath}. Setup sync can install it as the default path; repo-local CLAUDE guidance remains a project-level override.`,
        detectedPath: targetPath,
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      const statusAfter = await resolveClaudeWorkflowGuidanceState(context);
      return {
        agentId: 'claude-code',
        changed: false,
        dryRun,
        targetPath,
        statusBefore,
        statusAfter,
      };
    }
    throw error;
  }
}

export async function installAgentWorkflowGuidance(
  agentId: string,
  context: InstallAgentWorkflowGuidanceOptions = {},
): Promise<InstallAgentWorkflowGuidanceResult> {
  if (agentId === 'codex') {
    return installCodexWorkflowGuidance(context);
  }
  if (agentId === 'opencode') {
    return installOpenCodeWorkflowGuidance(context);
  }
  if (agentId === 'claude-code') {
    return installClaudeWorkflowGuidance(context);
  }

  throw new Error(`Atlas does not support automatic global workflow-guidance installation for "${agentId}" yet.`);
}

export async function removeAgentWorkflowGuidance(
  agentId: string,
  context: RemoveAgentWorkflowGuidanceOptions = {},
): Promise<RemoveAgentWorkflowGuidanceResult> {
  if (agentId === 'codex') {
    return removeCodexWorkflowGuidance(context);
  }
  if (agentId === 'opencode') {
    return removeOpenCodeWorkflowGuidance(context);
  }
  if (agentId === 'claude-code') {
    return removeClaudeWorkflowGuidance(context);
  }
  return {
    agentId,
    changed: false,
    dryRun: context.dryRun === true,
    targetPath: '',
    statusBefore: buildAgentWorkflowGuidanceState(agentId),
    statusAfter: buildAgentWorkflowGuidanceState(agentId),
  };
}

export function buildWorkflowPolicySummary(): string {
  return 'Global Atlas guidance only triggers on Atlas-named review prompts by default. Generic review prompts remain non-Atlas unless repo-local guidance broadens behavior for that project.';
}

export function buildSetupSeparationSummary(): string {
  return 'Selecting a shipped agent in MCP setup applies the full Atlas-managed global bundle when supported: MCP connectivity plus global workflow guidance. Repo-local Agent Rules remain available as project-level overrides.';
}
