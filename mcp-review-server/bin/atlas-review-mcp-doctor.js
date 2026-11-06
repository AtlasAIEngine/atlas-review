#!/usr/bin/env node

import process from 'node:process';

async function loadRuntime() {
  try {
    const [{ AtlasApiClient }, { loadConfig }, { resolveProjectContext }, { toAtlasMcpError }] = await Promise.all([
      import('../dist/src/client.js'),
      import('../dist/src/config.js'),
      import('../dist/src/context.js'),
      import('../dist/src/errors.js'),
    ]);

    return {
      AtlasApiClient,
      loadConfig,
      resolveProjectContext,
      toAtlasMcpError,
    };
  } catch (error) {
    console.error('FAIL Build artifacts missing for MCP doctor.');
    console.error('  Remediation: run `npm run build` and retry `npm run mcp:doctor`.');
    console.error(`  Details: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function printCheckResult(title, ok, lines = []) {
  const prefix = ok ? 'PASS' : 'FAIL';
  console.log(`${prefix} ${title}`);
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}

function renderBackendRemediation() {
  return [
    'Remediation:',
    '- Start backend: `cd ../backend && npm run dev`',
    '- Verify ATLAS_BACKEND_URL (default `http://localhost:3000/api`)',
    '- Confirm health endpoint: `curl -sS http://127.0.0.1:3000/health`',
  ];
}

function renderProjectRemediation() {
  return [
    'Remediation:',
    '- Run doctor from your project git root',
    '- Import project in Atlas UI, or enable `ATLAS_AUTO_IMPORT=true`',
    '- Confirm `/api/projects` includes your repo path',
  ];
}

function renderProviderRemediation() {
  return [
    'Remediation:',
    '- Configure at least one review-capable provider in Atlas settings',
    '- Set an active provider for review context in Atlas',
    '- Retry `npm run mcp:doctor`',
  ];
}

async function main() {
  const runtime = await loadRuntime();
  const config = runtime.loadConfig(process.env);
  const client = new runtime.AtlasApiClient(config);

  let failures = 0;
  console.log('Atlas Review MCP Doctor');
  console.log(`cwd: ${process.cwd()}`);
  console.log(`backend: ${config.backendUrl}`);
  console.log('');

  let backendReachable = false;
  try {
    const health = await client.getHealth();
    backendReachable = true;
    printCheckResult('Backend reachable', true, [
      `status=${typeof health.status === 'string' ? health.status : 'unknown'}`,
      `timestamp=${typeof health.timestamp === 'string' ? health.timestamp : 'unknown'}`,
    ]);
  } catch (error) {
    failures += 1;
    const mapped = runtime.toAtlasMcpError(error);
    printCheckResult('Backend reachable', false, [
      `[${mapped.code}] ${mapped.message}`,
      ...renderBackendRemediation(),
    ]);
  }

  let resolvedProject = null;
  if (backendReachable) {
    try {
      resolvedProject = await runtime.resolveProjectContext(client, config, process.cwd());
      printCheckResult('Project context resolution', true, [
        `gitRoot=${resolvedProject.gitRoot}`,
        `projectId=${resolvedProject.project.id}`,
        `projectName=${resolvedProject.project.name}`,
      ]);
    } catch (error) {
      failures += 1;
      const mapped = runtime.toAtlasMcpError(error);
      printCheckResult('Project context resolution', false, [
        `[${mapped.code}] ${mapped.message}`,
        ...renderProjectRemediation(),
      ]);
    }
  }

  if (backendReachable) {
    try {
      const [providersResponse, activeContext] = await Promise.all([
        client.listProviders(),
        client.getContextActiveProvider('review'),
      ]);

      const providers = Array.isArray(providersResponse.providers) ? providersResponse.providers : [];
      const activeProviderId = activeContext.data?.providerId || null;
      const activeModel = activeContext.data?.model || null;

      if (!activeProviderId) {
        failures += 1;
        printCheckResult('Review provider context', false, [
          'No active review provider is configured.',
          ...renderProviderRemediation(),
        ]);
      } else {
        const activeProvider = providers.find((entry) => entry.id === activeProviderId) || providersResponse.activeProvider || null;
        printCheckResult('Review provider context', true, [
          `activeProviderId=${activeProviderId}`,
          `activeProviderType=${activeProvider?.type || 'unknown'}`,
          `activeModel=${activeModel || activeProvider?.model || 'unknown'}`,
          `providerCount=${providers.length}`,
        ]);
      }
    } catch (error) {
      failures += 1;
      const mapped = runtime.toAtlasMcpError(error);
      printCheckResult('Review provider context', false, [
        `[${mapped.code}] ${mapped.message}`,
        ...renderProviderRemediation(),
      ]);
    }
  }

  if (resolvedProject) {
    console.log('');
    console.log('Suggested next MCP workflow:');
    console.log('- atlas_review_status');
    console.log('- atlas_review_latest');
    console.log('- atlas://review/current');
  }

  console.log('');
  if (failures > 0) {
    console.log(`Doctor finished with ${failures} failing check(s).`);
    process.exit(1);
  }

  console.log('Doctor finished with all checks passing.');
}

void main();
