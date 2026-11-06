import readline from 'node:readline/promises';
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

import {
  getAgentById,
  getAutoWriteAgents,
  type AgentId,
  type DetectedAgent,
} from './agentRegistry.js';
import { detectInstalledAgents } from './detector.js';
import {
  buildAgentGuidance,
  DEFAULT_SERVER_NAME,
  generateAgentConfigOutput,
  normalizeSetupBackendUrl,
  type GenerateAgentConfigOptions,
} from './configGenerator.js';
import { writeAgentConfig } from './configWriter.js';
import { installWorkflowGuidance, removeWorkflowGuidance } from './publicApi.js';

const execFileAsync = promisify(execFile);

interface SetupCliOptions {
  help: boolean;
  list: boolean;
  listJson: boolean;
  agentId?: string;
  workflowGuidanceAgentId?: string;
  removeWorkflowGuidanceAgentId?: string;
  json: boolean;
  dryRun: boolean;
  auto: boolean;
  backendUrl?: string;
  serverName: string;
}

function printSetupHelp(): void {
  console.log('Atlas Review MCP Setup');
  console.log('');
  console.log('Usage: atlas-review-mcp setup [options]');
  console.log('');
  console.log('Options:');
  console.log('  --list                   List supported agents and detection status');
  console.log('  --list-json              List supported agents in JSON format (legacy alias for --list --json)');
  console.log('  --agent=<id>             Configure one agent (claude-code, claude-desktop, vscode, cursor, codex, gemini, opencode)');
  console.log('  --install-workflow-guidance=<id>');
  console.log('                           Install Atlas global workflow guidance for one supported agent when Atlas has a deterministic path');
  console.log('  --remove-workflow-guidance=<id>');
  console.log('                           Remove Atlas-managed global workflow guidance for one supported agent without changing MCP config');
  console.log('  --auto                   Configure all detected installed shipped agents');
  console.log('  --dry-run                Show what would change without writing');
  console.log('  --json                   Print generated config snippet, or combine with --list for JSON detection output');
  console.log('  --backend-url=<url>      Override backend URL (default: http://127.0.0.1:3000/api)');
  console.log(`  --name=<serverName>       MCP server name (default: ${DEFAULT_SERVER_NAME})`);
  console.log('  -h, --help               Show this help');
  console.log('');
  console.log('Examples:');
  console.log('  atlas-review-mcp setup');
  console.log('  atlas-review-mcp setup --auto');
  console.log('  atlas-review-mcp setup --auto --dry-run');
  console.log('  atlas-review-mcp setup --agent=codex');
  console.log('  atlas-review-mcp setup --agent=claude-code --json');
  console.log('  atlas-review-mcp setup --install-workflow-guidance=codex');
  console.log('  atlas-review-mcp setup --remove-workflow-guidance=claude-code');
}

function parseArgs(argv: string[]): SetupCliOptions {
  const options: SetupCliOptions = {
    help: false,
    list: false,
    listJson: false,
    json: false,
    dryRun: false,
    auto: false,
    serverName: DEFAULT_SERVER_NAME,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    if (arg === '--list-json') {
      options.listJson = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--auto') {
      options.auto = true;
      continue;
    }
    if (arg.startsWith('--agent=')) {
      options.agentId = arg.slice('--agent='.length).trim();
      continue;
    }
    if (arg.startsWith('--install-workflow-guidance=')) {
      options.workflowGuidanceAgentId = arg.slice('--install-workflow-guidance='.length).trim();
      continue;
    }
    if (arg.startsWith('--remove-workflow-guidance=')) {
      options.removeWorkflowGuidanceAgentId = arg.slice('--remove-workflow-guidance='.length).trim();
      continue;
    }
    if (arg.startsWith('--backend-url=')) {
      options.backendUrl = arg.slice('--backend-url='.length).trim();
      continue;
    }
    if (arg.startsWith('--name=')) {
      const value = arg.slice('--name='.length).trim();
      options.serverName = value || DEFAULT_SERVER_NAME;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function asStatusLabel(detected: DetectedAgent): string {
  if (detected.parseError) return 'parse-error';
  if (!detected.isInstalled) return 'not-detected';
  if (detected.alreadyConfigured) return 'configured';
  return 'detected';
}

function printAgentList(detectedAgents: DetectedAgent[]): void {
  const header = ['Agent', 'Status', 'Support', 'Format', 'Config path'];
  const rows = detectedAgents.map((entry) => [
    entry.id,
    asStatusLabel(entry),
    entry.supportStatus,
    entry.format,
    entry.selectedConfigPath,
  ]);

  const widths = header.map((title, index) => {
    const rowMax = rows.reduce((max, row) => Math.max(max, row[index].length), 0);
    return Math.max(title.length, rowMax);
  });

  const renderRow = (columns: string[]) => columns.map((value, index) => value.padEnd(widths[index])).join('  ');
  console.log(renderRow(header));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(renderRow(row));
  }

  const parseErrors = detectedAgents.filter((entry) => !!entry.parseError);
  for (const entry of parseErrors) {
    console.log(`\n[WARN] ${entry.id}: ${entry.parseError}`);
  }
}

function asAgentIds(values: string[]): AgentId[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value): value is AgentId => !!getAgentById(value));
}

async function promptForAgentSelection(detectedAgents: DetectedAgent[]): Promise<AgentId[]> {
  const interactiveAgents = detectedAgents.filter((entry) => entry.autoWriteSupported);
  const manualOnlyAgents = detectedAgents.filter((entry) => !entry.autoWriteSupported);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('Shipped auto-write agents:');
    interactiveAgents.forEach((entry, index) => {
      const marker = entry.isInstalled ? '*' : ' ';
      const configured = entry.alreadyConfigured ? 'configured' : 'not configured';
      const support = entry.supportStatus === 'shipped' ? 'shipped' : `${entry.supportStatus}; manual review advised`;
      console.log(`  ${index + 1}. [${marker}] ${entry.displayName} (${entry.id}) — ${configured}, ${support}`);
    });
    if (manualOnlyAgents.length > 0) {
      console.log('');
      console.log('Manual-snippet-only agents (not selectable here):');
      manualOnlyAgents.forEach((entry) => {
        console.log(`  - ${entry.displayName} (${entry.id}) — use --agent=${entry.id} --json for snippet guidance`);
      });
    }
    console.log('');
    console.log('* installed config file detected');
    console.log('');
    const answer = await rl.question('Select shipped agents (e.g. 1,3 | a=all | Enter=detected): ');
    const normalized = answer.trim().toLowerCase();
    if (!normalized) {
      const detected = interactiveAgents.filter((entry) => entry.isInstalled).map((entry) => entry.id);
      if (detected.length > 0) return asAgentIds(detected);
      return ['claude-code'];
    }
    if (normalized === 'a' || normalized === 'all') {
      return asAgentIds(interactiveAgents.map((entry) => entry.id));
    }

    const selections = normalized.split(',').map((item) => item.trim()).filter(Boolean);
    const resolved: AgentId[] = [];
    for (const item of selections) {
      const numeric = Number(item);
      if (Number.isFinite(numeric) && numeric >= 1 && numeric <= interactiveAgents.length) {
        const selected = interactiveAgents[numeric - 1].id;
        if (!resolved.includes(selected)) resolved.push(selected);
        continue;
      }
      if (interactiveAgents.some((entry) => entry.id === item) && !resolved.includes(item as AgentId)) {
        resolved.push(item as AgentId);
      }
    }
    return resolved;
  } finally {
    rl.close();
  }
}

function printRestartHint(agentId: string, backendUrl: string, serverName: string): void {
  const guidance = buildAgentGuidance(agentId, { backendUrl, serverName });
  console.log(`  Restart: ${guidance.restartHint}`);
}

function shouldRunInteractive(options: SetupCliOptions): boolean {
  return !options.help
    && !options.list
    && !options.listJson
    && !options.json
    && !options.auto
    && !options.agentId
    && !options.workflowGuidanceAgentId
    && !options.removeWorkflowGuidanceAgentId
    && !options.dryRun;
}

async function resolveWorkspaceCwd(startCwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', startCwd, 'rev-parse', '--show-toplevel']);
    const gitRoot = stdout.trim();
    return gitRoot || startCwd;
  } catch {
    return startCwd;
  }
}

export async function runSetupCli(argv: string[]): Promise<number> {
  let options: SetupCliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Run `atlas-review-mcp setup --help` for usage.');
    return 1;
  }

  if (options.help) {
    printSetupHelp();
    return 0;
  }

  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  const serverName = options.serverName || DEFAULT_SERVER_NAME;
  const workspaceCwd = await resolveWorkspaceCwd(process.cwd());
  const detectedAgents = await detectInstalledAgents(
    {
      cwd: workspaceCwd,
    },
    { serverName }
  );

  if (options.listJson || (options.list && options.json)) {
    console.log(JSON.stringify(detectedAgents, null, 2));
    return 0;
  }

  if (options.list) {
    printAgentList(detectedAgents);
    return 0;
  }

  if (options.json) {
    if (!options.agentId) {
      console.error('--json requires --agent=<id> unless it is combined with --list.');
      return 1;
    }
    const output = await generateAgentConfigOutput(options.agentId, {
      backendUrl,
      serverName,
      cwd: workspaceCwd,
    });
    if (output.jsonObject) {
      console.log(JSON.stringify(output.jsonObject, null, 2));
    } else {
      console.log(
        JSON.stringify(
          {
            agent: output.agent.id,
            format: output.format,
            configPath: output.configPath,
            snippet: output.snippet,
          },
          null,
          2
        )
      );
    }
    return 0;
  }

  if (options.workflowGuidanceAgentId) {
    try {
      const result = await installWorkflowGuidance(options.workflowGuidanceAgentId, {
        dryRun: options.dryRun,
        cwd: workspaceCwd,
      });
      const action = result.dryRun ? 'DRY RUN' : 'WRITE';
      const changedLabel = result.changed ? 'yes' : 'no';
      console.log(`[${action}] Workflow guidance (${result.agentId})`);
      console.log(`  Target:  ${result.targetPath}`);
      console.log(`  Changed: ${changedLabel}`);
      console.log(`  Before:  ${result.statusBefore.label}`);
      console.log(`  After:   ${result.statusAfter.label}`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (options.removeWorkflowGuidanceAgentId) {
    try {
      const result = await removeWorkflowGuidance(options.removeWorkflowGuidanceAgentId, {
        dryRun: options.dryRun,
        cwd: workspaceCwd,
      });
      const action = result.dryRun ? 'DRY RUN' : 'WRITE';
      const changedLabel = result.changed ? 'yes' : 'no';
      console.log(`[${action}] Remove workflow guidance (${result.agentId})`);
      console.log(`  Target:  ${result.targetPath}`);
      console.log(`  Changed: ${changedLabel}`);
      console.log(`  Before:  ${result.statusBefore.label}`);
      console.log(`  After:   ${result.statusAfter.label}`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  let targetAgentIds: AgentId[] = [];
  if (shouldRunInteractive(options)) {
    targetAgentIds = await promptForAgentSelection(detectedAgents);
  } else if (options.auto) {
    const autoWriteSet = new Set(getAutoWriteAgents().map((agent) => agent.id));
    targetAgentIds = asAgentIds(
      detectedAgents
        .filter((entry) => entry.isInstalled && autoWriteSet.has(entry.id))
        .map((entry) => entry.id)
    );
    if (targetAgentIds.length === 0) {
      targetAgentIds = ['claude-code'];
    }
  } else if (options.agentId) {
    const agent = getAgentById(options.agentId);
    if (!agent) {
      console.error(`Unsupported agent "${options.agentId}".`);
      return 1;
    }
    if (!agent.autoWriteSupported && !options.dryRun) {
      console.error(`Agent "${options.agentId}" is not in the shipped v1 auto-write path. Use --json or --dry-run for manual setup guidance.`);
      return 1;
    }
    targetAgentIds = [agent.id];
  }

  if (targetAgentIds.length === 0) {
    console.error('No target agents selected.');
    return 1;
  }

  const failures: Array<{ agentId: string; message: string }> = [];
  for (const agentId of targetAgentIds) {
    try {
      const result = await writeAgentConfig({
        agentId,
        backendUrl,
        serverName,
        cwd: workspaceCwd,
        dryRun: options.dryRun,
      });

      const action = result.dryRun ? 'DRY RUN' : 'WRITE';
      if (result.changed) {
        console.log(`[${action}] ${result.agentDisplayName} (${result.agentId})`);
        console.log(`  Config:  ${result.configPath}`);
      } else {
        console.log(`[${action}] ${result.agentDisplayName} (${result.agentId}) already up to date`);
        console.log(`  Config:  ${result.configPath}`);
      }
      console.log(`  Backup:  ${result.backupPath || 'none'}`);
      console.log(`  Changed: ${result.changed ? 'yes' : 'no'}`);
      if (result.warnings.length > 0) {
        for (const warning of result.warnings) {
          console.log(`  Warning: ${warning}`);
        }
      }
      if (getAgentById(result.agentId)?.autoWriteSupported && result.agentId && (result.agentId === 'codex' || result.agentId === 'claude-code')) {
        const workflowGuidanceResult = await installWorkflowGuidance(result.agentId, {
          dryRun: options.dryRun,
          cwd: workspaceCwd,
        });
        console.log(`  Workflow guidance: ${workflowGuidanceResult.statusAfter.label}`);
        console.log(`  Guidance path:     ${workflowGuidanceResult.targetPath}`);
      }
      printRestartHint(result.agentId, backendUrl, serverName);
    } catch (error) {
      failures.push({
        agentId,
        message: error instanceof Error ? error.message : String(error),
      });
      console.error(`[ERROR] ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error(`Setup completed with ${failures.length} failure(s).`);
    return 1;
  }
  console.log('Setup completed successfully.');
  return 0;
}
