import { spawnSync } from 'node:child_process';
import process from 'node:process';

const ROOT_DIR = process.cwd();
const FRONTEND_DIR = 'frontend';
const GREP_PATTERN = 'lifecycle|retry|stale|approve|request|rerun';

function spawn(command, args, options = {}) {
  const baseEnv = options.inheritEnv === false ? {} : process.env;
  return spawnSync(command, args, {
    cwd: options.cwd ?? ROOT_DIR,
    env: {
      ...baseEnv,
      ...(options.env ?? {}),
    },
    stdio: 'inherit',
  });
}

function run(command, args, options = {}) {
  const result = spawn(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function runWithRetries(command, args, options = {}) {
  const retries = options.retries ?? 0;
  const delayMs = options.delayMs ?? 1000;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = spawn(command, args, options);
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      return;
    }

    if (attempt === retries) {
      process.exit(result.status ?? 1);
    }

    // Playwright can race on dynamic local port probing right after prior suites.
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

run('node', ['--check', 'backend/src/services/reviewService.js']);
run('node', ['--check', 'backend/src/utils/reviewLifecycle.js']);
run('npm', ['--prefix', 'backend', 'run', 'test:review-lifecycle-trust']);

// Let OS networking settle before Playwright reserves backend/frontend ports.
await new Promise((resolve) => setTimeout(resolve, 1000));

await runWithRetries(
  '/bin/zsh',
  [
    '-lc',
    `npx tsc --noEmit && PW_BACKEND_PORT=19000 PW_FRONTEND_PORT=19100 npx playwright test -c playwright.branch-review.config.ts --grep "${GREP_PATTERN}"`,
  ],
  {
    cwd: FRONTEND_DIR,
    retries: 2,
    delayMs: 1000,
  }
);
