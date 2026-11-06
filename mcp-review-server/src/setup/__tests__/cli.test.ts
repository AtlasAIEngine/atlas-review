import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runSetupCli } from '../cli.js';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function captureCliRun(
  args: string[],
  tempRoot: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  process.env.HOME = tempRoot;
  process.chdir(tempRoot);
  console.log = (...values: unknown[]) => {
    stdout.push(values.map((value) => String(value)).join(' '));
  };
  console.error = (...values: unknown[]) => {
    stderr.push(values.map((value) => String(value)).join(' '));
  };

  try {
    const exitCode = await runSetupCli(args);
    return {
      exitCode,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

test('runSetupCli writes by default for shipped single-agent setup and reports outcome details', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cli-write-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, '.codex', 'config.toml');
  const skillPath = path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md');
  const result = await captureCliRun(['--agent=codex'], tempRoot);

  assert.equal(result.exitCode, 0);
  assert.equal(await pathExists(configPath), true);
  assert.equal(await pathExists(skillPath), true);
  assert.match(result.stdout, /\[WRITE\] Codex \(codex\)/u);
  assert.match(result.stdout, new RegExp(`Config:\\s+${configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, /Backup:\s+none/u);
  assert.match(result.stdout, /Changed:\s+yes/u);
  assert.match(result.stdout, /Workflow guidance:\s+Managed global default active/u);
  assert.match(result.stdout, /Restart:\s+Restart Codex session\./u);
});

test('runSetupCli keeps dry-run mode non-destructive', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cli-dry-run-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, '.codex', 'config.toml');
  const result = await captureCliRun(['--auto', '--dry-run'], tempRoot);

  assert.equal(result.exitCode, 0);
  assert.equal(await pathExists(configPath), false);
  assert.match(result.stdout, /\[DRY RUN\]/u);
  assert.match(result.stdout, /Changed:\s+yes/u);
});

test('runSetupCli refuses default writes for experimental agents', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cli-experimental-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await captureCliRun(['--agent=cursor'], tempRoot);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not in the shipped v1 auto-write path/u);
});

test('runSetupCli list json exposes shared guidance metadata', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cli-list-json-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await captureCliRun(['--list', '--json'], tempRoot);

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  const codex = parsed.find((entry: any) => entry.id === 'codex');
  assert.ok(codex);
  assert.equal(codex.supportLabel, 'Shipped auto-write');
  assert.match(codex.restartHint, /Restart Codex session/u);
  assert.match(codex.recommendedCommands.preferred, /setup --agent=codex/u);

  const gemini = parsed.find((entry: any) => entry.id === 'gemini');
  assert.ok(gemini);
  assert.equal(gemini.supportLabel, 'Shipped auto-write');
  assert.match(gemini.restartHint, /Restart Gemini CLI session/u);
  assert.match(gemini.recommendedCommands.preferred, /setup --agent=gemini/u);

  const opencode = parsed.find((entry: any) => entry.id === 'opencode');
  assert.ok(opencode);
  assert.equal(opencode.supportLabel, 'Shipped auto-write');
  assert.match(opencode.restartHint, /Restart the active OpenCode session/u);
  assert.match(opencode.recommendedCommands.preferred, /setup --agent=opencode/u);

  const cursor = parsed.find((entry: any) => entry.id === 'cursor');
  assert.ok(cursor);
  assert.equal(cursor.supportLabel, 'Manual snippet only');
  assert.match(cursor.recommendedCommands.preferred, /setup --agent=cursor --json/u);
});

test('runSetupCli list prints support labels and resolved config paths', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cli-list-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await captureCliRun(['--list'], tempRoot);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Agent\s+Status\s+Support\s+Format\s+Config path/u);
  assert.match(result.stdout, /codex\s+not-detected\s+shipped\s+toml/u);
  assert.match(
    result.stdout,
    new RegExp(path.join(tempRoot, '.codex', 'config.toml').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
  assert.match(result.stdout, /gemini\s+not-detected\s+shipped\s+json/u);
  assert.match(
    result.stdout,
    new RegExp(path.join(tempRoot, '.gemini', 'settings.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
  assert.match(result.stdout, /opencode\s+not-detected\s+shipped\s+json/u);
  assert.match(
    result.stdout,
    new RegExp(path.join(tempRoot, '.config', 'opencode', 'opencode.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
  assert.match(result.stdout, /cursor\s+not-detected\s+experimental\s+json/u);
  assert.equal(result.stderr, '');
});

test('runSetupCli installs codex workflow guidance at the canonical skill path', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cli-workflow-install-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const skillPath = path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md');
  const result = await captureCliRun(['--install-workflow-guidance=codex'], tempRoot);

  assert.equal(result.exitCode, 0);
  assert.equal(await pathExists(skillPath), true);
  assert.match(result.stdout, /\[WRITE\] Workflow guidance \(codex\)/u);
  assert.match(result.stdout, /After:\s+Managed global default active/u);
});

test('runSetupCli installs opencode workflow guidance at the canonical skill path', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cli-opencode-workflow-install-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const skillPath = path.join(tempRoot, '.config', 'opencode', 'skills', 'atlas-review-global', 'SKILL.md');
  const result = await captureCliRun(['--install-workflow-guidance=opencode'], tempRoot);

  assert.equal(result.exitCode, 0);
  assert.equal(await pathExists(skillPath), true);
  assert.match(result.stdout, /\[WRITE\] Workflow guidance \(opencode\)/u);
  assert.match(result.stdout, /After:\s+Managed global default active/u);
});

test('runSetupCli help lists gemini as a supported --agent target', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cli-help-'));
  const result = await captureCliRun(['--help'], tempRoot);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /--agent=<id>\s+Configure one agent \(claude-code, claude-desktop, vscode, cursor, codex, gemini, opencode\)/u);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('runSetupCli installs claude workflow guidance at the canonical user memory path', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cli-claude-workflow-install-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const guidancePath = path.join(tempRoot, '.claude', 'CLAUDE.md');
  const result = await captureCliRun(['--install-workflow-guidance=claude-code'], tempRoot);

  assert.equal(result.exitCode, 0);
  assert.equal(await pathExists(guidancePath), true);
  assert.match(result.stdout, /\[WRITE\] Workflow guidance \(claude-code\)/u);
  assert.match(result.stdout, /After:\s+Managed global default active/u);
});

test('runSetupCli removes managed claude workflow guidance without touching config setup flow', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cli-claude-workflow-remove-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const guidancePath = path.join(tempRoot, '.claude', 'CLAUDE.md');
  await captureCliRun(['--install-workflow-guidance=claude-code'], tempRoot);
  const result = await captureCliRun(['--remove-workflow-guidance=claude-code'], tempRoot);

  assert.equal(result.exitCode, 0);
  assert.equal(await pathExists(guidancePath), false);
  assert.match(result.stdout, /\[WRITE\] Remove workflow guidance \(claude-code\)/u);
  assert.match(result.stdout, /Before:\s+Managed global default active/u);
  assert.match(result.stdout, /After:\s+Managed global default available/u);
});
