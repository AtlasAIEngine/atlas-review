/**
 * Slash command discovery and expansion for Claude Code-compatible prompts.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import logger from '../utils/logger.js';

const execAsync = promisify(exec);
const MAX_FILE_BYTES = 200000;

const BUILT_IN_COMMANDS = [
  { name: 'add-dir', description: 'Add additional working directories' },
  { name: 'agents', description: 'Manage custom AI subagents for specialized tasks' },
  { name: 'bashes', description: 'List and manage background tasks' },
  { name: 'bug', description: 'Report bugs (sends conversation to Anthropic)' },
  { name: 'clear', description: 'Clear conversation history', supported: true },
  { name: 'compact', description: '[instructions] Compact conversation with optional focus instructions', supported: true },
  { name: 'config', description: 'Open the Settings interface (Config tab)' },
  { name: 'context', description: 'Visualize current context usage as a colored grid' },
  { name: 'cost', description: 'Show token usage statistics. See cost tracking guide for subscription-specific details.' },
  { name: 'doctor', description: 'Checks the health of your Claude Code installation' },
  { name: 'exit', description: 'Exit the REPL' },
  { name: 'export', description: '[filename] Export the current conversation to a file or clipboard' },
  { name: 'help', description: 'Get usage help', supported: true },
  { name: 'hooks', description: 'Manage hook configurations for tool events' },
  { name: 'ide', description: 'Manage IDE integrations and show status' },
  { name: 'init', description: 'Initialize project with CLAUDE.md guide' },
  { name: 'install-github-app', description: 'Set up Claude GitHub Actions for a repository' },
  { name: 'login', description: 'Switch Anthropic accounts' },
  { name: 'logout', description: 'Sign out from your Anthropic account' },
  { name: 'mcp', description: 'Manage MCP server connections and OAuth authentication' },
  { name: 'memory', description: 'Edit CLAUDE.md memory files' },
  { name: 'model', description: 'Select or change the AI model' },
  { name: 'output-style', description: '[style] Set the output style directly or from a selection menu' },
  { name: 'permissions', description: 'View or update permissions' },
  { name: 'plan', description: 'Enter plan mode directly from the prompt' },
  { name: 'plugin', description: 'Manage Claude Code plugins' },
  { name: 'pr-comments', description: 'View pull request comments' },
  { name: 'privacy-settings', description: 'View and update your privacy settings' },
  { name: 'release-notes', description: 'View release notes' },
  { name: 'rename', description: '<name> Rename the current session for easier identification' },
  { name: 'remote-env', description: 'Configure remote session environment (claude.ai subscribers)' },
  { name: 'resume', description: '[session] Resume a conversation by ID or name, or open the session picker' },
  { name: 'review', description: 'Request code review' },
  { name: 'rewind', description: 'Rewind the conversation and/or code' },
  { name: 'sandbox', description: 'Enable sandboxed bash tool with filesystem and network isolation for safer, more autonomous execution' },
  { name: 'security-review', description: 'Complete a security review of pending changes on the current branch' },
  { name: 'stats', description: 'Visualize daily usage, session history, streaks, and model preferences' },
  { name: 'status', description: 'Open the Settings interface (Status tab) showing version, model, account, and connectivity' },
  { name: 'statusline', description: 'Set up Claude Code status line UI' },
  { name: 'teleport', description: 'Resume a remote session from claude.ai by session ID, or open a picker (claude.ai subscribers)' },
  { name: 'terminal-setup', description: 'Install Shift+Enter key binding for newlines (VS Code, Alacritty, Zed, Warp)' },
  { name: 'theme', description: 'Change the color theme' },
  { name: 'todos', description: 'List current TODO items' },
  { name: 'usage', description: 'For subscription plans only: show plan usage limits and rate limit status' },
  { name: 'vim', description: 'Enter vim mode for alternating insert and command modes' },
].map((command) => ({
  ...command,
  command: `/${command.name}`,
  type: 'builtin',
  scope: 'builtin',
}));

const BUILT_IN_COMMAND_MAP = new Map(BUILT_IN_COMMANDS.map((command) => [command.name, command]));

const COMMAND_INPUT_REGEX = /^\/([a-zA-Z0-9-]+(?::[a-zA-Z0-9-]+)?)(?:\s+([\s\S]*))?$/;
const FILE_REFERENCE_REGEX = /@([\w./-]+)/g;
const BASH_REFERENCE_REGEX = /!\s*`([^`]+)`/g;

const parseFrontmatter = (content) => {
  const lines = content.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') {
    return { attributes: {}, body: content };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { attributes: {}, body: content };
  }

  const fmLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join('\n');
  const attributes = {};
  let currentKey = null;

  for (const line of fmLines) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      currentKey = key;
      attributes[currentKey] = value.trim();
    } else if (currentKey) {
      const prevValue = attributes[currentKey] || '';
      attributes[currentKey] = prevValue ? `${prevValue}\n${line}` : line;
    }
  }

  return { attributes, body };
};

const firstNonEmptyLine = (content) => {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim()) return line.trim();
  }
  return '';
};

const stripQuotes = (value) => {
  if (!value) return value;
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseCommandArguments = (rawArguments) => {
  if (!rawArguments) return [];
  const regex = /"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s]+)/g;
  const args = [];
  let match;
  while ((match = regex.exec(rawArguments)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
  }
  return args;
};

const buildCommandPrompt = async (command, rawArguments, projectPath) => {
  const args = parseCommandArguments(rawArguments);
  const argsString = rawArguments?.trim() || '';

  let content = command.prompt || '';
  if (!content.trim()) {
    content = command.description || '';
  }

  content = content.replace(/\$ARGUMENTS/g, argsString);
  content = content.replace(/\$(\d+)/g, (match, index) => {
    const value = args[Number(index) - 1];
    return value ?? '';
  });

  const { expanded: bashExpanded, warnings: bashWarnings } = await expandBashCommands(
    content,
    command.allowedTools,
    projectPath
  );
  const { expanded: fileExpanded, warnings: fileWarnings } = await expandFileReferences(
    bashExpanded,
    projectPath
  );

  return {
    prompt: fileExpanded,
    warnings: [...bashWarnings, ...fileWarnings],
  };
};

const parseAllowedBashPatterns = (allowedTools) => {
  if (!allowedTools) return [];
  const matches = [...allowedTools.matchAll(/Bash\(([^)]+)\)/g)];
  const patterns = [];
  for (const match of matches) {
    const inner = match[1];
    inner.split(',').forEach((item) => {
      const trimmed = item.trim();
      if (trimmed) patterns.push(trimmed);
    });
  }
  return patterns;
};

const isBashCommandAllowed = (command, allowedTools) => {
  const patterns = parseAllowedBashPatterns(allowedTools);
  if (patterns.length === 0) return false;
  const trimmed = command.trim();
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    if (normalized.endsWith('*')) {
      const prefix = normalized.slice(0, -1).trim();
      return prefix && trimmed.startsWith(prefix);
    }
    if (normalized.includes(':')) {
      const [base, qualifier] = normalized.split(':');
      if (qualifier && qualifier.trim() === '*') {
        const prefix = base.trim();
        return prefix && trimmed.startsWith(prefix);
      }
      return trimmed === base.trim();
    }
    return trimmed === normalized;
  });
};

const expandBashCommands = async (content, allowedTools, projectPath) => {
  const warnings = [];
  let result = '';
  let lastIndex = 0;

  for (const match of content.matchAll(BASH_REFERENCE_REGEX)) {
    const command = match[1].trim();
    result += content.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;

    if (!command) continue;
    if (!isBashCommandAllowed(command, allowedTools)) {
      warnings.push(`Bash command not permitted: ${command}`);
      result += `\n\n[Command not permitted: ${command}]\n\n`;
      continue;
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: projectPath,
        maxBuffer: 200000,
        timeout: 10000,
      });
      const output = [stdout, stderr].filter(Boolean).join('').trim();
      result += `\n\n$ ${command}\n${output || '(no output)'}\n\n`;
    } catch (error) {
      const stderr = error?.stderr ? error.stderr.toString() : '';
      const stdout = error?.stdout ? error.stdout.toString() : '';
      const details = [stdout, stderr].filter(Boolean).join('').trim();
      warnings.push(`Bash command failed: ${command}`);
      result += `\n\n$ ${command}\n${details || error.message}\n\n`;
    }
  }

  result += content.slice(lastIndex);
  return { expanded: result, warnings };
};

const readFileWithinProject = async (projectPath, filePath) => {
  const resolvedPath = path.resolve(projectPath, filePath);
  const relative = path.relative(projectPath, resolvedPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('File reference is outside the project directory.');
  }

  const stats = await fs.stat(resolvedPath);
  if (stats.size > MAX_FILE_BYTES) {
    const content = await fs.readFile(resolvedPath, 'utf8');
    return `${content.slice(0, MAX_FILE_BYTES)}\n\n[File truncated: ${filePath}]`;
  }

  return fs.readFile(resolvedPath, 'utf8');
};

const expandFileReferences = async (content, projectPath) => {
  const warnings = [];
  let result = '';
  let lastIndex = 0;

  for (const match of content.matchAll(FILE_REFERENCE_REGEX)) {
    const filePath = match[1];
    result += content.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;

    try {
      const fileContent = await readFileWithinProject(projectPath, filePath);
      result += `\n\n[File: ${filePath}]\n${fileContent}\n\n`;
    } catch (error) {
      warnings.push(`Unable to read file: ${filePath}`);
      result += `\n\n[Missing file: ${filePath}]\n\n`;
      logger.warn(`Slash command file reference error for ${filePath}: ${error.message}`);
    }
  }

  result += content.slice(lastIndex);
  return { expanded: result, warnings };
};

const readCommandsFromDir = async (rootDir, scope) => {
  const commands = [];
  try {
    const stats = await fs.stat(rootDir);
    if (!stats.isDirectory()) return commands;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`Slash command directory not accessible: ${rootDir} (${error.message})`);
    }
    return commands;
  }

  const walk = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }

      try {
        const rawContent = await fs.readFile(entryPath, 'utf8');
        const { attributes, body } = parseFrontmatter(rawContent);
        const name = path.basename(entry.name, '.md');
        const relativeDir = path.relative(rootDir, path.dirname(entryPath));
        const namespace = relativeDir && relativeDir !== '.' ? relativeDir.split(path.sep).join('/') : null;
        const description = stripQuotes(attributes.description) || firstNonEmptyLine(body);

        commands.push({
          name,
          command: `/${name}`,
          description,
          argumentHint: stripQuotes(attributes['argument-hint']) || null,
          allowedTools: stripQuotes(attributes['allowed-tools']) || null,
          model: stripQuotes(attributes.model) || null,
          disableModelInvocation: (attributes['disable-model-invocation'] || '').toLowerCase() === 'true',
          hooks: attributes.hooks || null,
          prompt: body.trim(),
          scope,
          namespace,
          type: 'custom',
          sourcePath: entryPath,
        });
      } catch (error) {
        logger.warn(`Failed to read slash command file ${entryPath}: ${error.message}`);
      }
    }
  };

  await walk(rootDir);
  return commands;
};

export const getBuiltInCommands = () => BUILT_IN_COMMANDS;

export const getCustomCommands = async (projectPath) => {
  const projectDir = path.join(projectPath, '.claude', 'commands');
  const userDir = path.join(os.homedir(), '.claude', 'commands');
  const [projectCommands, userCommands] = await Promise.all([
    readCommandsFromDir(projectDir, 'project'),
    readCommandsFromDir(userDir, 'user'),
  ]);

  const commandMap = new Map();
  for (const command of userCommands) {
    commandMap.set(command.name, command);
  }
  for (const command of projectCommands) {
    commandMap.set(command.name, command);
  }

  return Array.from(commandMap.values());
};

export const getSlashCommands = async (projectPath) => {
  const customCommands = await getCustomCommands(projectPath);
  const customNames = new Set(customCommands.map((command) => command.name));
  const builtIns = BUILT_IN_COMMANDS.filter((command) => !customNames.has(command.name));
  return [...customCommands, ...builtIns];
};

export const resolveSlashCommand = async ({ input, projectPath }) => {
  if (!input || typeof input !== 'string') {
    return { isCommand: false };
  }

  const trimmed = input.trim();
  const match = trimmed.match(COMMAND_INPUT_REGEX);
  if (!match) {
    return { isCommand: false };
  }

  const [, token, rawArguments = ''] = match;
  const [namespace, name] = token.includes(':') ? token.split(':', 2) : [null, token];
  const customCommands = await getCustomCommands(projectPath);

  const command = namespace
    ? customCommands.find((item) => item.name === name && item.namespace === namespace)
    : customCommands.find((item) => item.name === name);

  if (command) {
    const expanded = await buildCommandPrompt(command, rawArguments, projectPath);
    return {
      isCommand: true,
      type: 'custom',
      command: `/${name}`,
      prompt: expanded.prompt,
      warnings: expanded.warnings,
      meta: {
        name,
        scope: command.scope,
        namespace: command.namespace || null,
        sourcePath: command.sourcePath,
        arguments: rawArguments,
      },
    };
  }

  if (!namespace && BUILT_IN_COMMAND_MAP.has(name)) {
    return {
      isCommand: true,
      type: 'builtin',
      command: `/${name}`,
      builtIn: BUILT_IN_COMMAND_MAP.get(name),
    };
  }

  return { isCommand: false };
};
