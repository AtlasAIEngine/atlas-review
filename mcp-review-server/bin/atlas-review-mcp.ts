#!/usr/bin/env node
import { startServer } from '../src/index.js';
import { runSetupCli } from '../src/setup/cli.js';

function printHelp(): void {
  console.log('Atlas Review MCP Server');
  console.log('');
  console.log('Usage: atlas-review-mcp [--help] | atlas-review-mcp setup [options]');
  console.log('');
  console.log('Commands:');
  console.log('- setup                  Configure MCP client config files');
  console.log('');
  console.log('Environment variables:');
  console.log('- ATLAS_BACKEND_URL (default: http://localhost:3000/api)');
  console.log('- ATLAS_API_TOKEN (optional bearer token)');
  console.log('- ATLAS_AUTO_IMPORT (default: false)');
  console.log('- ATLAS_REQUEST_TIMEOUT_MS (default: 120000)');
  console.log('- ATLAS_ENABLE_WATCHER_SYNC (default: false)');
  console.log('');
  console.log('Setup examples:');
  console.log('- atlas-review-mcp setup');
  console.log('- atlas-review-mcp setup --auto');
  console.log('- atlas-review-mcp setup --auto --dry-run');
  console.log('- atlas-review-mcp setup --agent=codex');
  console.log('- atlas-review-mcp setup --agent=claude-code --json');
  console.log('- atlas-review-mcp setup --agent=claude-code --backend-url=http://127.0.0.1:3001/api --name=atlas-review-dev');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const firstArg = args[0];

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (firstArg === 'setup') {
    const exitCode = await runSetupCli(args.slice(1));
    process.exit(exitCode);
  }

  if (firstArg && !firstArg.startsWith('-')) {
    console.error(`Unknown command: ${firstArg}`);
    printHelp();
    process.exit(1);
  }

  await startServer();
}

void main();
