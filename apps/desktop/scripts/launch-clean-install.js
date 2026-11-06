#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopDir = path.resolve(__dirname, '..');
const projectRoot = path.resolve(desktopDir, '..', '..');

function parseArgs(argv) {
  const options = {
    mode: 'release',
    dryRun: false,
    keepTemp: false,
    port: process.env.ATLAS_BACKEND_PORT || '4120',
    tempRoot: null,
  };

  for (const arg of argv) {
    if (arg === '--debug') {
      options.mode = 'debug';
      continue;
    }
    if (arg === '--release') {
      options.mode = 'release';
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--keep-temp') {
      options.keepTemp = true;
      continue;
    }
    if (arg.startsWith('--port=')) {
      options.port = arg.slice('--port='.length).trim() || options.port;
      continue;
    }
    if (arg.startsWith('--temp-root=')) {
      options.tempRoot = arg.slice('--temp-root='.length).trim() || null;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log('AtlasEngine Desktop Clean Install Launcher');
  console.log('');
  console.log('Launches the desktop app in an isolated temp HOME with CLI detection disabled.');
  console.log('Useful for testing the first-run setup wizard and initial CLI install flow.');
  console.log('');
  console.log('Usage: node apps/desktop/scripts/launch-clean-install.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --release           Use target/release/atlasengine-desktop (default)');
  console.log('  --debug             Use target/debug/atlasengine-desktop');
  console.log('  --port=<port>       Backend port override (default: 4120)');
  console.log('  --temp-root=<dir>   Reuse a specific temp root instead of creating one');
  console.log('  --keep-temp         Do not delete temp root instructions on exit');
  console.log('  --dry-run           Print resolved paths/env without launching');
  console.log('  -h, --help          Show this help');
  console.log('');
  console.log('Notes:');
  console.log('  - The release binary is recommended because debug builds may still use Tauri devUrl.');
  console.log('  - This launcher sets ATLAS_DISABLE_CLI_PROVIDER_DETECTION=1.');
  console.log('  - This flow assumes a fresh database sandbox, not an in-place upgrade of an older desktop DB.');
}

function resolveBinaryPath(mode) {
  const exeName = process.platform === 'win32' ? 'atlasengine-desktop.exe' : 'atlasengine-desktop';
  return path.join(projectRoot, 'apps', 'desktop', 'src-tauri', 'target', mode, exeName);
}

function ensureBinaryExists(binaryPath) {
  if (!fs.existsSync(binaryPath)) {
    const normalizedPath = path.normalize(binaryPath);
    const isDebug = normalizedPath.includes(`${path.sep}debug${path.sep}`);
    throw new Error(
      `Desktop binary not found at ${binaryPath}. Build it first with npm run desktop:build${isDebug ? ':debug' : ''}.`
    );
  }
}

function createSandbox(tempRootOverride) {
  const root = tempRootOverride
    ? path.resolve(tempRootOverride)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-desktop-clean-install.'));
  fs.mkdirSync(root, { recursive: true });

  const homeDir = root;
  const atlasDataDir = path.join(root, 'Library', 'Application Support', 'dev.atlasengine.desktop');
  const appDataDir = path.join(root, 'appdata');

  return {
    root,
    homeDir,
    atlasDataDir,
    projectsDir: path.join(atlasDataDir, 'projects'),
    logsDir: path.join(atlasDataDir, 'logs'),
    tempDir: path.join(atlasDataDir, 'temp'),
    mcpConfigRoot: homeDir,
    appDataDir,
  };
}

function buildEnv(sandbox, port) {
  return {
    ...process.env,
    HOME: sandbox.homeDir,
    USERPROFILE: sandbox.homeDir,
    ATLAS_DATA_DIR: sandbox.atlasDataDir,
    ATLAS_PROJECTS_DIR: sandbox.projectsDir,
    ATLAS_LOGS_DIR: sandbox.logsDir,
    ATLAS_TEMP_DIR: sandbox.tempDir,
    ATLAS_ENABLE_MCP_SETUP_API: 'true',
    ATLAS_DISABLE_CLI_PROVIDER_DETECTION: '1',
    ATLAS_BACKEND_PORT: String(port),
  };
}

function printLaunchSummary(binaryPath, sandbox, env, options) {
  console.log(`Mode: ${options.mode}`);
  console.log(`Binary: ${binaryPath}`);
  console.log(`Sandbox root: ${sandbox.root}`);
  console.log(`HOME: ${sandbox.homeDir}`);
  console.log(`Atlas data dir: ${sandbox.atlasDataDir}`);
  console.log(`Backend port: ${env.ATLAS_BACKEND_PORT}`);
  console.log(`CLI detection disabled: ${env.ATLAS_DISABLE_CLI_PROVIDER_DETECTION}`);
  console.log(`MCP setup API enabled: ${env.ATLAS_ENABLE_MCP_SETUP_API}`);
  if (!options.keepTemp) {
    console.log(`Cleanup later: rm -rf ${JSON.stringify(sandbox.root)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const binaryPath = resolveBinaryPath(options.mode);
  ensureBinaryExists(binaryPath);

  const sandbox = createSandbox(options.tempRoot);
  const env = buildEnv(sandbox, options.port);

  printLaunchSummary(binaryPath, sandbox, env, options);

  if (options.dryRun) {
    return;
  }

  const child = spawn(binaryPath, [], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
