#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const runnerPath = path.resolve(__dirname, 'review-pr-benchmark-matrix.mjs');
const defaultArgs = [
  runnerPath,
  '--fixture-set', 'project_black_real_prs',
  '--surface', 'pr_review',
  '--manifest', 'config/review-harness-benchmarks/project-black/benchmark-manifest.json',
  '--out-dir', '.artifacts/review-harness-benchmarks/project-black/matrix',
];

const child = spawn(process.execPath, [...defaultArgs, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
