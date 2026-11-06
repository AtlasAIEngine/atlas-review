import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const ROOT_DIR = process.cwd();

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

function assertPhaseCorroborationSuites() {
  const backendPackagePath = `${ROOT_DIR}/backend/package.json`;
  const backendPackageJson = JSON.parse(readFileSync(backendPackagePath, 'utf8'));
  const corroborationScript = backendPackageJson?.scripts?.['test:review-corroboration-calibration'];
  const requiredSuites = [
    'src/services/__tests__/reviewPromptContext.test.js',
    'src/services/__tests__/reviewCorroborationService.test.js',
    'src/services/__tests__/reviewEvidenceValidator.test.js',
    'src/services/__tests__/reviewOutcomeService.test.js',
    'src/services/__tests__/reviewPipeline.integration.test.js',
    'src/services/__tests__/reviewQualityHarness.test.js',
  ];

  if (typeof corroborationScript !== 'string') {
    throw new Error('Missing backend npm script: test:review-corroboration-calibration');
  }

  const missingSuites = requiredSuites.filter((suitePath) => !corroborationScript.includes(suitePath));
  if (missingSuites.length > 0) {
    throw new Error(
      `test:review-corroboration-calibration is missing required suites: ${missingSuites.join(', ')}`
    );
  }
}

assertPhaseCorroborationSuites();

run('node', ['--check', 'backend/src/services/reviewCorroborationService.js']);
run('node', ['--check', 'backend/src/services/reviewService.js']);
run('node', ['--check', 'backend/src/services/reviewEvidenceValidator.js']);
run('node', ['--check', 'backend/src/services/reviewPrecisionMetrics.js']);
run('node', ['--check', 'backend/src/services/reviewOutcomeService.js']);
run('node', ['--check', 'backend/src/services/reviewQualityHarness.js']);
run('node', ['--check', 'backend/src/services/gitService.js']);
run('node', ['--check', 'backend/src/services/branchReviewService.js']);
run('node', ['--check', 'backend/src/services/memoryService.js']);
run('node', ['--check', 'backend/src/routes/reviews.js']);
run('npm', ['--prefix', 'backend', 'run', 'test:review-corroboration-calibration']);
run('npx', ['tsc', '--noEmit', '-p', 'frontend/tsconfig.json']);
