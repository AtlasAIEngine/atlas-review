import { spawnSync } from 'node:child_process';
import process from 'node:process';

const ROOT_DIR = process.cwd();
const GREP_PATTERN = 'review|rerun|progress|coverage|rollout|gate|lifecycle';

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
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

run('node', ['--check', 'backend/src/services/reviewService.js']);
run('node', ['--check', 'backend/src/services/providerService.js']);
run('node', ['--check', 'backend/src/services/reviewQualityHarness.js']);
run('node', ['--check', 'backend/src/routes/settings.js']);
run('npm', ['--prefix', 'backend', 'run', 'test:review-speed-coverage']);
run('/bin/zsh', ['-lc', 'cd frontend && npx tsc --noEmit']);

// Let OS networking settle before Playwright reserves backend/frontend ports.
await new Promise((resolve) => setTimeout(resolve, 1000));

await runWithRetries(
  'npm',
  [
    '--prefix',
    'frontend',
    'run',
    'test:branch-review-workflow',
    '--',
    '--grep',
    GREP_PATTERN,
  ],
  {
    retries: 2,
    delayMs: 1000,
  }
);
