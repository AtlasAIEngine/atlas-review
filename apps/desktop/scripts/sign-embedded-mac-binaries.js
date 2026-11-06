#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, openSync, readSync, closeSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopDir = dirname(__dirname);
const tauriDir = join(desktopDir, 'src-tauri');

function walkFiles(dirPath) {
  const files = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? desktopDir,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env ?? process.env,
    encoding: options.capture ? 'utf8' : undefined,
  });
}

function isMachOBinary(filePath) {
  // Avoid spawning `file` for thousands of JavaScript and metadata files.
  let descriptor;
  try {
    descriptor = openSync(filePath, 'r');
    const header = Buffer.alloc(4);
    if (readSync(descriptor, header, 0, 4, 0) !== 4) return false;
    const magic = header.toString('hex');
    if (!['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)) return false;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    const description = String(run('file', [filePath], { capture: true }));
    return description.includes('Mach-O');
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const options = {
    resourcesDir: join(tauriDir, 'resources'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === '--resources-dir' || arg === '-r') && next) {
      options.resourcesDir = resolve(next);
      index += 1;
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const identity = process.env.APPLE_SIGNING_IDENTITY_HASH || process.env.APPLE_SIGNING_IDENTITY;
const keychainPath = process.env.APPLE_KEYCHAIN_PATH;

if (!identity) {
  throw new Error('APPLE_SIGNING_IDENTITY or APPLE_SIGNING_IDENTITY_HASH is required');
}

if (!keychainPath) {
  throw new Error('APPLE_KEYCHAIN_PATH is required');
}

if (!existsSync(options.resourcesDir)) {
  console.log(`Resources directory not found, skipping embedded macOS signing: ${options.resourcesDir}`);
  process.exit(0);
}

const nativeFiles = walkFiles(options.resourcesDir).filter((filePath) => isMachOBinary(filePath));

if (nativeFiles.length === 0) {
  console.log(`No embedded macOS binaries found under ${options.resourcesDir}`);
  process.exit(0);
}

console.log(`Pre-signing ${nativeFiles.length} embedded macOS binaries under ${options.resourcesDir}`);

for (const filePath of nativeFiles) {
  run('codesign', [
    '--force',
    '--sign',
    identity,
    '--keychain',
    keychainPath,
    '--timestamp',
    filePath,
  ]);
}

console.log('Embedded macOS binary signing complete');
