#!/usr/bin/env node

/**
 * Bundle Backend Script for AtlasEngine Desktop
 *
 * This script prepares the backend for bundling with Tauri:
 * 1. Copies the backend code to src-tauri/resources/backend/
 * 2. Downloads the platform-specific Node.js binary
 * 3. Places it in src-tauri/binaries/ with Tauri sidecar naming
 *
 * Node.js binaries are named according to Tauri sidecar convention:
 * - macOS ARM: node-aarch64-apple-darwin
 * - macOS x64: node-x86_64-apple-darwin
 * - Windows: node-x86_64-pc-windows-msvc.exe
 * - Linux: node-x86_64-unknown-linux-gnu
 */

import { execSync } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync, chmodSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import https from 'https';
import * as tar from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
function getArgValue(name) {
  const eqArg = args.find(a => a.startsWith(`--${name}=`));
  if (eqArg) return eqArg.split('=')[1];
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return null;
}
const targetArg = getArgValue('target');

// Paths
const DESKTOP_DIR = dirname(__dirname);
const SRC_TAURI_DIR = join(DESKTOP_DIR, 'src-tauri');
const BINARIES_DIR = join(SRC_TAURI_DIR, 'binaries');
const RESOURCES_DIR = join(SRC_TAURI_DIR, 'resources');
const BACKEND_RESOURCE_DIR = join(RESOURCES_DIR, 'backend');
const SHARED_RESOURCE_DIR = join(RESOURCES_DIR, 'shared');
const PROJECT_ROOT = join(DESKTOP_DIR, '..', '..');
const BACKEND_SRC_DIR = join(PROJECT_ROOT, 'backend');
const SHARED_SRC_DIR = join(PROJECT_ROOT, 'shared');
const TEMPLATES_SRC_DIR = join(PROJECT_ROOT, 'templates');
const TEMPLATES_RESOURCE_DIR = join(RESOURCES_DIR, 'templates');
const MCP_SERVER_SRC_DIR = join(PROJECT_ROOT, 'mcp-review-server');
const MCP_SERVER_RESOURCE_DIR = join(RESOURCES_DIR, 'mcp-review-server');
const MCP_SERVER_DIST_DIR = join(MCP_SERVER_SRC_DIR, 'dist');
const RUNTIME_FINGERPRINT_FILE = join(RESOURCES_DIR, 'atlas-runtime-fingerprint.txt');
const RUNTIME_MANIFEST_FILE = join(RESOURCES_DIR, 'atlas-runtime-manifest.json');

const SENSITIVE_FILENAMES = new Set([
  '.atlas-providers.json',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '.encryption-key',
  'atlas.db',
]);

const SENSITIVE_EXTENSIONS = [
  '.cer',
  '.crt',
  '.db',
  '.der',
  '.key',
  '.log',
  '.p12',
  '.pem',
  '.pfx',
  '.sqlite',
  '.sqlite3',
];

// Node.js version to bundle
// IMPORTANT: Must match the system Node.js version used for `npm install`
// to ensure native modules (like better-sqlite3) have compatible bindings.
function isSensitiveFilename(name) {
  return SENSITIVE_FILENAMES.has(name) || name.startsWith('.atlas-providers.json.') || /^\.env(?:\.|$)/.test(name)
    || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(name)
    || name === '.tauri_updater_key';
}

// Override with ATLAS_NODE_VERSION if needed.
const NODE_VERSION = (process.env.ATLAS_NODE_VERSION || process.versions.node).replace(/^v/, '');

// Platform mappings for Tauri sidecar naming
const PLATFORM_MAP = {
  'darwin-arm64': {
    tauriTarget: 'aarch64-apple-darwin',
    nodeArch: 'arm64',
    nodePlatform: 'darwin',
    npmPlatform: 'darwin',
    ext: '',
  },
  'darwin-x64': {
    tauriTarget: 'x86_64-apple-darwin',
    nodeArch: 'x64',
    nodePlatform: 'darwin',
    npmPlatform: 'darwin',
    ext: '',
  },
  'win32-x64': {
    tauriTarget: 'x86_64-pc-windows-msvc',
    nodeArch: 'x64',
    nodePlatform: 'win',
    npmPlatform: 'win32',
    ext: '.exe',
  },
  'linux-x64': {
    tauriTarget: 'x86_64-unknown-linux-gnu',
    nodeArch: 'x64',
    nodePlatform: 'linux',
    npmPlatform: 'linux',
    ext: '',
  },
};

/**
 * Get current platform key
 */
function getCurrentPlatform() {
  return `${process.platform}-${process.arch}`;
}

function getResolvedPlatformKey() {
  return targetArg ? getPlatformFromTarget(targetArg) : getCurrentPlatform();
}

/**
 * Get platform key from target triple (e.g., "aarch64-apple-darwin" -> "darwin-arm64")
 */
function getPlatformFromTarget(target) {
  const entry = Object.entries(PLATFORM_MAP).find(([_, v]) => v.tauriTarget === target);
  if (!entry) {
    console.error(`Unknown target triple: ${target}`);
    console.error('Supported targets:', Object.values(PLATFORM_MAP).map(v => v.tauriTarget).join(', '));
    process.exit(1);
  }
  return entry[0];
}

/**
 * Download a file from URL
 */
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);

    const request = (url) => {
      https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          request(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        rmSync(destPath, { force: true });
        reject(err);
      });
    };

    request(url);
  });
}

/**
 * Extract Node.js binary from tarball
 */
async function extractNodeBinary(tarPath, destPath, nodePlatform) {
  const tempDir = join(dirname(tarPath), 'node-extract-temp');
  mkdirSync(tempDir, { recursive: true });

  try {
    await tar.x({
      file: tarPath,
      cwd: tempDir,
      filter: (path) => path.includes('/bin/node') || path.endsWith('/node.exe'),
    });

    // Find the node binary in extracted files
    const files = readdirSync(tempDir);
    for (const dir of files) {
      const binDir = join(tempDir, dir, 'bin');
      if (existsSync(binDir)) {
        const nodeBin = join(binDir, 'node');
        if (existsSync(nodeBin)) {
          copyFileSync(nodeBin, destPath);
          chmodSync(destPath, 0o755);
          return;
        }
      }
      // Windows puts node.exe directly in the folder
      const nodeExe = join(tempDir, dir, 'node.exe');
      if (existsSync(nodeExe)) {
        copyFileSync(nodeExe, destPath);
        return;
      }
    }

    throw new Error('Could not find node binary in archive');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Download and install Node.js binary for the target platform
 * If --target is specified, use that; otherwise use current platform
 */
async function installNodeBinary() {
  const platformKey = getResolvedPlatformKey();
  const platform = PLATFORM_MAP[platformKey];

  if (!platform) {
    console.error(`Unsupported platform: ${platformKey}`);
    console.error('Supported platforms:', Object.keys(PLATFORM_MAP).join(', '));
    process.exit(1);
  }

  const { tauriTarget, nodeArch, nodePlatform, ext } = platform;
  const binaryName = `node-${tauriTarget}${ext}`;
  const destPath = join(BINARIES_DIR, binaryName);

  // Check if already exists
  if (existsSync(destPath)) {
    console.log(`  Node.js binary already exists: ${binaryName}`);
    return;
  }

  const targetInfo = targetArg ? ` (target: ${targetArg})` : ' (current platform)';
  console.log(`  Downloading Node.js v${NODE_VERSION} for ${platformKey}${targetInfo}...`);

  // Construct download URL
  const archiveExt = nodePlatform === 'win' ? 'zip' : 'tar.gz';
  const archiveName = `node-v${NODE_VERSION}-${nodePlatform}-${nodeArch}.${archiveExt}`;
  const downloadUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;

  const tempArchive = join(BINARIES_DIR, archiveName);

  try {
    await downloadFile(downloadUrl, tempArchive);
    const checksumsPath = join(BINARIES_DIR, 'SHASUMS256.txt');
    await downloadFile(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, checksumsPath);
    const checksumLine = readFileSync(checksumsPath, 'utf8').split('\n').find(line => line.trim().endsWith(`  ${archiveName}`));
    const actual = createHash('sha256').update(readFileSync(tempArchive)).digest('hex');
    if (!checksumLine || checksumLine.split(/\s+/)[0] !== actual) throw new Error('Node archive checksum mismatch');
    console.log('  Extracting Node.js binary...');

    if (archiveExt === 'zip') {
      // Windows: extract using unzip or PowerShell
      const extractDir = join(BINARIES_DIR, 'node-extract');
      mkdirSync(extractDir, { recursive: true });

      try {
        execSync(`unzip -q "${tempArchive}" -d "${extractDir}"`, { stdio: 'pipe' });
      } catch {
        execSync(
          `powershell -Command "Expand-Archive -Path '${tempArchive}' -DestinationPath '${extractDir}'"`,
          { stdio: 'pipe' }
        );
      }

      const files = readdirSync(extractDir);
      const nodeExe = join(extractDir, files[0], 'node.exe');
      copyFileSync(nodeExe, destPath);
      rmSync(extractDir, { recursive: true, force: true });
    } else {
      // Unix: extract using tar
      await extractNodeBinary(tempArchive, destPath, nodePlatform);
    }

    console.log(`  Installed: ${binaryName}`);
  } finally {
    rmSync(tempArchive, { force: true });
  }
}

function getBundledNodeBinaryPath() {
  const platformKey = getResolvedPlatformKey();
  const platform = PLATFORM_MAP[platformKey];

  if (!platform) {
    throw new Error(`Unsupported platform for runtime fingerprint: ${platformKey}`);
  }

  const { tauriTarget, ext } = platform;
  return join(BINARIES_DIR, `node-${tauriTarget}${ext}`);
}

/**
 * Copy directory recursively
 */
function copyDirSync(src, dest, exclude = [], excludeExtensions = []) {
  mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    // Skip excluded names
    if (exclude.includes(entry.name) || isSensitiveFilename(entry.name)) {
      continue;
    }

    // Skip excluded extensions
    if ([...SENSITIVE_EXTENSIONS, ...excludeExtensions].some((ext) => entry.name.endsWith(ext))) {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, exclude, excludeExtensions);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function collectSensitiveBundleFiles(rootDir, relativeDir = '') {
  if (!existsSync(rootDir)) return [];

  const findings = [];
  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
    const absolutePath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      findings.push(...collectSensitiveBundleFiles(absolutePath, relativePath));
      continue;
    }
    if (isSensitiveFilename(entry.name) || SENSITIVE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      findings.push(relativePath);
    }
  }
  return findings;
}

function assertNoSensitiveBundleFiles(dir, label) {
  const findings = collectSensitiveBundleFiles(dir);
  if (findings.length === 0) return;

  console.error(`  Refusing to bundle ${label}; sensitive-looking files were copied:`);
  for (const filePath of findings) {
    console.error(`    - ${filePath}`);
  }
  process.exit(1);
}

function stableModifiedTimeMs(stat) {
  return Number.isFinite(stat.mtimeMs) ? Math.trunc(stat.mtimeMs) : 0;
}

function hashPathMetadata(absolutePath, relativePath, hasher, stats) {
  const metadata = statSync(absolutePath);
  const normalizedRelativePath = relativePath.replace(/\\/g, '/');
  hasher.update(normalizedRelativePath);
  hasher.update('\0');
  hasher.update(String(metadata.size));
  hasher.update('\0');
  hasher.update(String(stableModifiedTimeMs(metadata)));
  hasher.update('\0');

  if (stats && metadata.isFile()) {
    stats.files += 1;
    stats.bytes += metadata.size;
  }
}

function hashDirectoryMetadata(rootDir, currentDir, hasher, stats) {
  const entries = readdirSync(currentDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    const relativePath = relative(rootDir, absolutePath) || entry.name;
    hashPathMetadata(absolutePath, relativePath, hasher, stats);

    if (entry.isDirectory()) {
      hashDirectoryMetadata(rootDir, absolutePath, hasher, stats);
    }
  }
}

function writeRuntimeFingerprint() {
  console.log('\n4. Writing Windows runtime fingerprint...');

  const startedAt = Date.now();
  const hasher = createHash('sha256');
  const stats = { files: 0, bytes: 0 };
  const nodeBinaryPath = getBundledNodeBinaryPath();

  if (!existsSync(nodeBinaryPath)) {
    throw new Error(`Bundled Node.js binary missing for runtime fingerprint: ${nodeBinaryPath}`);
  }

  hashPathMetadata(nodeBinaryPath, 'node.exe', hasher, stats);
  hashDirectoryMetadata(RESOURCES_DIR, RESOURCES_DIR, hasher, stats);

  const fingerprint = hasher.digest('hex').slice(0, 16);
  writeFileSync(RUNTIME_FINGERPRINT_FILE, `${fingerprint}\n`, 'utf8');

  console.log(
    `  Runtime fingerprint: ${fingerprint} (${stats.files} files, ${(stats.bytes / (1024 * 1024)).toFixed(1)} MB scanned in ${Date.now() - startedAt}ms)`
  );
}

function directoryContainsNativeModule(packageDir) {
  const entries = readdirSync(packageDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(packageDir, entry.name);
    if (entry.isDirectory()) {
      if (directoryContainsNativeModule(entryPath)) {
        return true;
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.node')) {
      return true;
    }
  }
  return false;
}

function collectTopLevelNativeBackendPackages() {
  const nodeModulesDir = join(BACKEND_RESOURCE_DIR, 'node_modules');
  if (!existsSync(nodeModulesDir)) {
    return [];
  }

  const nativePackages = [];
  const entries = readdirSync(nodeModulesDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name.startsWith('@')) {
      const scopeDir = join(nodeModulesDir, entry.name);
      const scopedEntries = readdirSync(scopeDir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;
        const packageName = `${entry.name}/${scopedEntry.name}`;
        if (directoryContainsNativeModule(join(scopeDir, scopedEntry.name))) {
          nativePackages.push(packageName);
        }
      }
      continue;
    }

    if (directoryContainsNativeModule(join(nodeModulesDir, entry.name))) {
      nativePackages.push(entry.name);
    }
  }

  return nativePackages;
}

function writeRuntimeManifest() {
  console.log('\n5. Writing Windows runtime manifest...');

  const startedAt = Date.now();
  const nativeBackendPackages = collectTopLevelNativeBackendPackages();
  writeFileSync(
    RUNTIME_MANIFEST_FILE,
    `${JSON.stringify({ nativeBackendPackages }, null, 2)}\n`,
    'utf8'
  );

  console.log(
    `  Runtime manifest: ${nativeBackendPackages.length} native backend package(s) in ${Date.now() - startedAt}ms`
  );
  for (const packageName of nativeBackendPackages) {
    console.log(`    - ${packageName}`);
  }
}

function hasUsableMcpDist() {
  const requiredFiles = [
    join(MCP_SERVER_DIST_DIR, 'bin', 'atlas-review-mcp.js'),
    join(MCP_SERVER_DIST_DIR, 'src', 'index.js'),
  ];

  return requiredFiles.every((filePath) => existsSync(filePath));
}

/**
 * Copy backend code to resources directory
 */
function copyBackendCode() {
  console.log('  Copying backend code...');

  // Clean previous copy
  if (existsSync(BACKEND_RESOURCE_DIR)) {
    rmSync(BACKEND_RESOURCE_DIR, { recursive: true, force: true });
  }

  // Files/directories to exclude (simple string match, not regex)
  const exclude = [
    'node_modules',
    '.git',
    '.env',
    '.env.local',
    'uploads',
    'logs',
    '.artifacts',
    '.npm-cache',
    'projects', // User projects
    '.DS_Store',
    'coverage',
    '.nyc_output',
  ];

  // File extensions to exclude
  const excludeExtensions = [];

  copyDirSync(BACKEND_SRC_DIR, BACKEND_RESOURCE_DIR, exclude, excludeExtensions);
  assertNoSensitiveBundleFiles(BACKEND_RESOURCE_DIR, 'backend resources');

  console.log('  Backend code copied');
}

/**
 * Copy shared runtime helpers used by bundled backend/frontend code.
 */
function copySharedCode() {
  if (!existsSync(SHARED_SRC_DIR)) {
    console.log('  Shared code directory not found, skipping');
    return;
  }

  console.log('  Copying shared code...');

  if (existsSync(SHARED_RESOURCE_DIR)) {
    rmSync(SHARED_RESOURCE_DIR, { recursive: true, force: true });
  }

  const exclude = [
    '.DS_Store',
  ];
  const excludeExtensions = [];
  copyDirSync(SHARED_SRC_DIR, SHARED_RESOURCE_DIR, exclude, excludeExtensions);
  assertNoSensitiveBundleFiles(SHARED_RESOURCE_DIR, 'shared resources');

  console.log('  Shared code copied');
}

/**
 * Copy templates to resources directory
 */
function copyTemplates() {
  if (!existsSync(TEMPLATES_SRC_DIR)) {
    console.log('  Templates directory not found, skipping');
    return;
  }

  console.log('  Copying templates...');

  if (existsSync(TEMPLATES_RESOURCE_DIR)) {
    rmSync(TEMPLATES_RESOURCE_DIR, { recursive: true, force: true });
  }

  const exclude = ['.DS_Store'];
  copyDirSync(TEMPLATES_SRC_DIR, TEMPLATES_RESOURCE_DIR, exclude);

  console.log('  Templates copied');
}

/**
 * Build MCP review server distribution in source workspace.
 */
function buildMcpServerSource() {
  if (!existsSync(MCP_SERVER_SRC_DIR)) {
    console.log('  MCP server directory not found, skipping');
    return;
  }

  console.log('  Building MCP review server dist...');
  try {
    execSync('npm run build', {
      cwd: MCP_SERVER_SRC_DIR,
      stdio: 'inherit',
      env: process.env,
    });
  } catch (error) {
    console.error('  Failed to build MCP review server:', error.message);
    process.exit(1);
  }
}

/**
 * Copy MCP review server into desktop resources.
 */
function copyMcpServerCode() {
  if (!existsSync(MCP_SERVER_SRC_DIR)) {
    console.log('  MCP server directory not found, skipping');
    return;
  }

  console.log('  Copying MCP review server...');

  if (existsSync(MCP_SERVER_RESOURCE_DIR)) {
    rmSync(MCP_SERVER_RESOURCE_DIR, { recursive: true, force: true });
  }

  const exclude = [
    'node_modules',
    '.npm-cache',
    '.git',
    '.env',
    '.env.local',
    '.DS_Store',
    'coverage',
  ];
  const excludeExtensions = [];

  copyDirSync(MCP_SERVER_SRC_DIR, MCP_SERVER_RESOURCE_DIR, exclude, excludeExtensions);
  assertNoSensitiveBundleFiles(MCP_SERVER_RESOURCE_DIR, 'MCP review server resources');
  console.log('  MCP review server copied');
}

/**
 * Install runtime dependencies for bundled MCP review server.
 */
function installMcpServerDeps() {
  if (!existsSync(join(MCP_SERVER_RESOURCE_DIR, 'package.json'))) {
    console.log('  MCP server package.json not found, skipping dependency install');
    return;
  }
  if (!existsSync(join(MCP_SERVER_RESOURCE_DIR, 'package-lock.json'))) {
    console.error('  MCP server package-lock.json not found; refusing non-reproducible dependency install');
    process.exit(1);
  }

  console.log('  Installing MCP review server dependencies (production)...');
  try {
    execSync('npm ci --omit=dev', {
      cwd: MCP_SERVER_RESOURCE_DIR,
      stdio: 'inherit',
      env: process.env,
    });

    // Guard against accidental local npm cache growth inside bundled resources.
    const localNpmCache = join(MCP_SERVER_RESOURCE_DIR, '.npm-cache');
    if (existsSync(localNpmCache)) {
      rmSync(localNpmCache, { recursive: true, force: true });
    }
    console.log('  MCP dependencies installed');
  } catch (error) {
    console.error('  Failed to install MCP dependencies:', error.message);
    process.exit(1);
  }
}

/**
 * Install backend dependencies (production only)
 */
function installBackendDeps() {
  console.log('  Installing backend dependencies (production)...');

  try {
    const platformKey = targetArg ? getPlatformFromTarget(targetArg) : getCurrentPlatform();
    const platformInfo = PLATFORM_MAP[platformKey];
    const env = { ...process.env };

    if (targetArg && platformInfo) {
      // Ensure native modules (e.g., better-sqlite3) are built/downloaded for the target arch
      env.npm_config_arch = env.npm_config_arch || platformInfo.nodeArch;
      env.npm_config_target_arch = env.npm_config_target_arch || platformInfo.nodeArch;
      env.npm_config_platform = env.npm_config_platform || platformInfo.npmPlatform;
      env.npm_config_target_platform = env.npm_config_target_platform || platformInfo.npmPlatform;
    }

    // Use npm install with --omit=dev for production dependencies only
    // NOTE: Do NOT use --ignore-scripts as native modules like better-sqlite3
    // need to run postinstall scripts to compile their bindings
    execSync('npm ci --omit=dev', {
      cwd: BACKEND_RESOURCE_DIR,
      stdio: 'inherit',
      env,
    });
    console.log('  Dependencies installed');
  } catch (error) {
    console.error('  Failed to install dependencies:', error.message);
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('\n========================================');
  console.log(' AtlasEngine Desktop - Bundle Backend');
  console.log('========================================\n');

  // Ensure directories exist
  mkdirSync(BINARIES_DIR, { recursive: true });
  mkdirSync(RESOURCES_DIR, { recursive: true });

  await downloadFile(`https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`, join(RESOURCES_DIR, 'node-LICENSE.txt'));
  console.log('1. Setting up Node.js binary...');
  await installNodeBinary();

  console.log('\n2. Bundling backend code...');
  copyBackendCode();

  console.log('\n2b. Bundling shared code...');
  copySharedCode();

  console.log('\n2c. Bundling templates...');
  copyTemplates();

  console.log('\n3. Installing production dependencies...');
  installBackendDeps();

  console.log('\n2d. Bundling MCP review server...');
  buildMcpServerSource();
  copyMcpServerCode();

  console.log('\n3b. Installing MCP server dependencies...');
  installMcpServerDeps();

  execSync('node scripts/rust-notices.mjs', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  execSync('node scripts/dependency-notices.mjs', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  writeRuntimeFingerprint();
  writeRuntimeManifest();

  console.log('\n========================================');
  console.log(' Bundle complete!');
  console.log('========================================\n');
  console.log(`  Node.js: ${BINARIES_DIR}`);
  console.log(`  Backend: ${BACKEND_RESOURCE_DIR}`);
  console.log(`  MCP: ${MCP_SERVER_RESOURCE_DIR}`);
  console.log('');
}

main().catch((error) => {
  console.error('Bundle failed:', error);
  process.exit(1);
});
