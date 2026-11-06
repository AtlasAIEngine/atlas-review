#!/usr/bin/env node

/**
 * Cross-platform start script for AtlasEngine MVP.
 * Starts backend and frontend in a single command.
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dirExists(path) {
  return existsSync(join(ROOT_DIR, path));
}

function fileExists(path) {
  return existsSync(join(ROOT_DIR, path));
}

function loadEnvFile(path) {
  if (!fileExists(path)) {
    return {};
  }
  const content = readFileSync(join(ROOT_DIR, path), 'utf-8');
  const lines = content.split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT_DIR,
      env: options.env || process.env,
      stdio: options.silent ? 'pipe' : 'inherit',
      shell: options.shell || false
    });

    let stdout = '';
    let stderr = '';

    if (options.silent && child.stdout && child.stderr) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('error', (error) => {
      resolve({ success: false, error, stdout, stderr });
    });

    child.on('close', (code) => {
      resolve({ success: code === 0, stdout, stderr });
    });
  });
}

async function commandExists(command) {
  const result = await runCommand(command, ['--version'], { silent: true });
  return result.success;
}

async function isDockerRunning() {
  const result = await runCommand('docker', ['info'], { silent: true });
  return result.success;
}

async function startDockerDesktop() {
  const os = platform();

  if (os === 'darwin') {
    console.log('Attempting to start Docker Desktop...');
    await runCommand('open', ['-a', 'Docker'], { silent: true });
  } else if (os === 'win32') {
    console.log('Attempting to start Docker Desktop...');
    const paths = [
      'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      `${process.env.LOCALAPPDATA}\\Docker\\Docker Desktop.exe`
    ];
    for (const dockerPath of paths) {
      if (existsSync(dockerPath)) {
        await runCommand('cmd', ['/c', 'start', '', dockerPath], { silent: true, shell: true });
        break;
      }
    }
  } else {
    console.log('Please start Docker manually.');
    return false;
  }

  console.log('Waiting for Docker to start (up to 60 seconds)...');
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    if (await isDockerRunning()) {
      console.log('Docker is now running.');
      return true;
    }
    process.stdout.write(`\rWaiting... ${(i + 1) * 2}s`);
  }

  console.log('\nDocker failed to start within 60 seconds.');
  return false;
}

async function checkPostgres(env) {
  if (process.env.ATLAS_SKIP_DB_CHECK === '1') {
    console.log('Skipping database check (ATLAS_SKIP_DB_CHECK=1).');
    return true;
  }

  const hasPgIsReady = await commandExists('pg_isready');
  if (!hasPgIsReady) {
    console.log('pg_isready not found; skipping database readiness check.');
    return true;
  }

  const host = process.env.DB_HOST || env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || env.DB_PORT || '5432';
  const user = process.env.DB_USER || env.DB_USER || 'atlasengine';

  const result = await runCommand(
    'pg_isready',
    ['-h', host, '-p', port, '-U', user],
    { silent: true }
  );

  if (result.success) {
    console.log('PostgreSQL is reachable.');
    return true;
  }

  console.log('PostgreSQL is not reachable.');
  console.log('Start Postgres and ensure backend/.env is configured.');
  console.log('Set ATLAS_SKIP_DB_CHECK=1 to bypass this check.');
  return false;
}

async function main() {
  console.log('Starting AtlasEngine MVP...');

  const missingDeps =
    !dirExists('node_modules') ||
    !dirExists('backend/node_modules') || !dirExists('frontend/node_modules');

  if (missingDeps) {
    console.log('Installing dependencies...');
    await runCommand('npm', ['install'], { cwd: ROOT_DIR });
    await runCommand('npm', ['install'], { cwd: join(ROOT_DIR, 'backend') });
    await runCommand('npm', ['install'], { cwd: join(ROOT_DIR, 'frontend') });
    console.log('Dependencies installed.');
  }

  if (!fileExists('backend/.env')) {
    console.log('backend/.env not found. See backend/.env.example.');
  }

  if (!fileExists('frontend/.env')) {
    console.log('frontend/.env not found. See frontend/.env.example.');
  }

  if (!(await isDockerRunning())) {
    console.log('Docker is not running.');
    const started = await startDockerDesktop();
    if (!started) {
      console.log('Please start Docker and try again.');
      process.exit(1);
    }
  }

  const backendEnv = loadEnvFile('backend/.env');
  const dbReady = await checkPostgres(backendEnv);
  if (!dbReady) {
    process.exit(1);
  }

  console.log('Starting backend and frontend...');
  await runCommand(
    'npx',
    [
      'concurrently',
      '--names',
      'BACKEND,FRONTEND',
      '--prefix-colors',
      'blue,magenta',
      '--kill-others',
      '--kill-others-on-fail',
      '--handle-input',
      'cd backend && npm run dev',
      'cd frontend && npm run dev'
    ],
    {
      cwd: ROOT_DIR
    }
  );
}

main().catch((error) => {
  console.error('Start failed:', error.message);
  process.exit(1);
});
