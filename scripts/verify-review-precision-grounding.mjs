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

function assertPhase3PrecisionSuites() {
  const backendPackagePath = `${ROOT_DIR}/backend/package.json`;
  const backendPackageJson = JSON.parse(readFileSync(backendPackagePath, 'utf8'));
  const precisionScript = backendPackageJson?.scripts?.['test:review-precision-grounding'];
  const requiredSuites = [
    'src/services/__tests__/reviewPromptContext.test.js',
    'src/services/__tests__/reviewEvidenceValidator.test.js',
    'src/services/__tests__/reviewOutcomeService.test.js',
    'src/services/__tests__/reviewPipeline.integration.test.js',
    'src/services/__tests__/reviewQualityHarness.test.js',
  ];

  if (typeof precisionScript !== 'string') {
    throw new Error('Missing backend npm script: test:review-precision-grounding');
  }

  const missingSuites = requiredSuites.filter((suitePath) => !precisionScript.includes(suitePath));
  if (missingSuites.length > 0) {
    throw new Error(
      `test:review-precision-grounding is missing required Phase 3 suites: ${missingSuites.join(', ')}`
    );
  }
}

assertPhase3PrecisionSuites();

run('node', ['--check', 'backend/src/services/reviewEvidenceValidator.js']);
run('node', ['--check', 'backend/src/services/reviewService.js']);
run('node', ['--check', 'backend/src/services/reviewPrecisionMetrics.js']);
run('node', ['--check', 'backend/src/services/reviewOutcomeService.js']);
run('node', ['--check', 'backend/src/services/reviewQualityHarness.js']);
run('node', ['--check', 'backend/src/services/providerService.js']);
run('node', ['--check', 'backend/src/services/branchReviewService.js']);
run('node', ['--check', 'backend/src/services/verificationService.js']);
run('node', ['--check', 'backend/src/routes/reviews.js']);
run('npm', ['--prefix', 'backend', 'run', 'test:review-precision-grounding']);
run('/bin/zsh', ['-lc', 'cd frontend && npx tsc --noEmit']);
