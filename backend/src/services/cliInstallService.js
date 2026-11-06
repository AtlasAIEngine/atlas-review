/**
 * CLI Install Service
 * Downloads npm on-demand and installs CLI tools (Claude Code, Codex, Gemini)
 * into a local prefix directory — no admin rights or global npm required.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import crypto from 'crypto';
import { execFileSync, execSync, spawn } from 'child_process';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'zlib';
import { extract as tarExtract } from 'tar';
import { Readable } from 'node:stream';
import { getAppDataDir } from '../config/paths.js';

/**
 * Server-side allowlist — only these packages can be installed.
 * Keys are the user-facing identifiers; values are npm package names.
 */
const ALLOWED_PACKAGES = {
  'claude-code': '@anthropic-ai/claude-code',
  'codex': '@openai/codex',
  'gemini-cli': '@google/gemini-cli',
};

/** npm version to download when system npm is unavailable */
const NPM_DOWNLOAD_VERSION = '10.9.2';
const GIT_FOR_WINDOWS_RELEASE_API = 'https://api.github.com/repos/git-for-windows/git/releases/latest';
const VISUAL_CPP_REDIST_URLS = {
  x64: 'https://aka.ms/vc14/vc_redist.x64.exe',
  x86: 'https://aka.ms/vc14/vc_redist.x86.exe',
};
const VISUAL_CPP_REDIST_SUCCESS_CODES = new Set([0, 1638, 3010]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getInstallPrefix() {
  return path.join(getAppDataDir(), 'cli-tools');
}

function getNpmCacheDir() {
  return path.join(getAppDataDir(), 'npm-cache');
}

function getPortableGitRoot() {
  return path.join(getAppDataDir(), 'portable-git');
}

function getPortableGitBashPath(root = getPortableGitRoot()) {
  return path.join(root, 'bin', 'bash.exe');
}

function getPortableGitCmdPath(root = getPortableGitRoot()) {
  return path.join(root, 'cmd');
}

function getShellProfilesForPathSetup(homeDir, platform = process.platform) {
  const isMac = platform === 'darwin';
  if (isMac) {
    // macOS terminal apps usually start login shells, so prioritize login
    // profiles first and only fall back to interactive ones to avoid
    // missing PATH updates in new terminals.
    return [
      path.join(homeDir, '.zprofile'),
      path.join(homeDir, '.bash_profile'),
      path.join(homeDir, '.zshrc'),
      path.join(homeDir, '.bashrc'),
    ];
  }

  return [
    path.join(homeDir, '.zshrc'),
    path.join(homeDir, '.bashrc'),
  ];
}

function getWindowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function isWindowsSandboxEnvironment(
  env = process.env,
  platform = process.platform,
) {
  if (platform !== 'win32') {
    return false;
  }

  const username = String(env?.USERNAME || env?.USER || '').trim().toLowerCase();
  if (username === 'wdagutilityaccount') {
    return true;
  }

  const userProfile = String(env?.USERPROFILE || '').trim().toLowerCase();
  return userProfile.includes('\\users\\wdagutilityaccount\\');
}

function getGitBashPathCandidates(platform = process.platform) {
  if (platform !== 'win32') {
    return [];
  }

  const configuredPath = process.env.CLAUDE_CODE_GIT_BASH_PATH?.trim();
  return [...new Set([
    configuredPath || null,
    getPortableGitBashPath(),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
  ].filter(Boolean))];
}

function findExistingGitBashPath(platform = process.platform) {
  if (platform !== 'win32') {
    return null;
  }

  for (const candidate of getGitBashPathCandidates(platform)) {
    try {
      fsSync.accessSync(candidate);
      return candidate;
    } catch {
      // Not found
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// npm availability
// ---------------------------------------------------------------------------

/**
 * Check whether system npm is available and where it lives.
 * Also checks for a previously-downloaded local npm.
 */
async function checkNpmAvailability() {
  // 1. System npm
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
    if (npmRoot) {
      return { available: true, source: 'system', npmCliPath: null };
    }
  } catch {
    // Not available
  }

  // 2. Cached local npm
  const localNpmCli = path.join(getNpmCacheDir(), 'package', 'bin', 'npm-cli.js');
  try {
    await fs.access(localNpmCli);
    return { available: true, source: 'local', npmCliPath: localNpmCli };
  } catch {
    // Not cached yet
  }

  return { available: false, source: null, npmCliPath: null };
}

// ---------------------------------------------------------------------------
// npm download
// ---------------------------------------------------------------------------

/**
 * Download the npm package tarball from the registry and extract it.
 * Returns the path to npm-cli.js.
 */
/**
 * Follow redirects and return a Node.js readable stream for the response body.
 */
function httpsGet(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    https.get(url, {
      headers: {
        'User-Agent': 'AtlasEngine Desktop',
        'Accept': 'application/octet-stream, application/vnd.github+json',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain
        return resolve(httpsGet(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function httpsGetJson(url) {
  const stream = await httpsGet(url);
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function downloadFile(url, destinationPath) {
  const stream = await httpsGet(url);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await pipeline(stream, fsSync.createWriteStream(destinationPath));
}

async function downloadNpm(onProgress) {
  const cacheDir = getNpmCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });

  const tarballUrl = `https://registry.npmjs.org/npm/-/npm-${NPM_DOWNLOAD_VERSION}.tgz`;

  onProgress?.({ type: 'progress', message: `Downloading npm ${NPM_DOWNLOAD_VERSION} from registry...` });

  const stream = await httpsGet(tarballUrl);

  onProgress?.({ type: 'progress', message: 'Extracting npm...' });

  await pipeline(
    stream,
    createGunzip(),
    tarExtract({ cwd: cacheDir, strip: 0 }),
  );

  const npmCliPath = path.join(cacheDir, 'package', 'bin', 'npm-cli.js');
  try {
    await fs.access(npmCliPath);
  } catch {
    throw new Error('npm extraction failed: npm-cli.js not found');
  }

  onProgress?.({ type: 'progress', message: 'npm ready.' });
  return npmCliPath;
}

// ---------------------------------------------------------------------------
// Ensure npm is available (system or downloaded)
// ---------------------------------------------------------------------------

/**
 * Returns the command + args to invoke npm.
 * If system npm exists, returns { cmd: 'npm', args: [] }.
 * Otherwise downloads npm and returns { cmd: process.execPath, args: [npmCliPath] }.
 */
async function ensureNpm(onProgress) {
  const status = await checkNpmAvailability();

  if (status.available && status.source === 'system') {
    return { cmd: 'npm', args: [], source: 'system' };
  }

  if (status.available && status.source === 'local') {
    return { cmd: process.execPath, args: [status.npmCliPath], source: 'local' };
  }

  // Download npm
  const npmCliPath = await downloadNpm(onProgress);
  return { cmd: process.execPath, args: [npmCliPath], source: 'downloaded' };
}

function buildNpmSpawnEnv() {
  const nodeDir = path.dirname(process.execPath);
  const spawnEnv = { ...process.env, npm_config_loglevel: 'notice' };
  const pathKey = Object.keys(spawnEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const currentPath = spawnEnv[pathKey] || '';
  if (!currentPath.includes(nodeDir)) {
    spawnEnv[pathKey] = `${nodeDir}${path.delimiter}${currentPath}`;
  }
  return spawnEnv;
}

// ---------------------------------------------------------------------------
// CLI installation
// ---------------------------------------------------------------------------

/**
 * Install a CLI tool by packageKey.
 * Streams progress events via the onProgress callback.
 *
 * @param {string} packageKey - One of 'claude-code', 'codex', 'gemini-cli'
 * @param {function} onProgress - Called with { type: 'progress'|'complete'|'error', message }
 */
async function installCLI(packageKey, onProgress) {
  const npmPackage = ALLOWED_PACKAGES[packageKey];
  if (!npmPackage) {
    throw new Error(`Unknown package: ${packageKey}. Allowed: ${Object.keys(ALLOWED_PACKAGES).join(', ')}`);
  }

  const prefix = getInstallPrefix();
  await fs.mkdir(prefix, { recursive: true });

  onProgress?.({ type: 'progress', message: `Preparing to install ${npmPackage}...` });

  // Get npm
  const npm = await ensureNpm(onProgress);

  onProgress?.({ type: 'progress', message: `Installing ${npmPackage}...` });

  // Build command
  const spawnArgs = [
    ...npm.args,
    'install', '-g',
    '--prefix', prefix,
    npmPackage,
  ];

  return new Promise((resolve, reject) => {
    const spawnEnv = buildNpmSpawnEnv();

    const proc = spawn(npm.cmd, spawnArgs, {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: shouldUseShellForNpm(npm.source, process.platform),
      windowsHide: true,
    });

    let stderr = '';

    proc.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        onProgress?.({ type: 'progress', message: line });
      }
    });

    proc.stderr.on('data', (data) => {
      const line = data.toString().trim();
      stderr += line + '\n';
      if (line && !line.startsWith('npm warn')) {
        onProgress?.({ type: 'progress', message: line });
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn npm: ${err.message}`));
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`npm install exited with code ${code}. ${stderr.slice(-500)}`));
        return;
      }

      // Verify binary exists
      const binaryName = getBinaryName(packageKey);
      const binaryPath = findInstalledBinary(binaryName);

      try {
        await ensureHealthyInstall(packageKey, { npm, prefix, binaryPath, onProgress, spawnEnv });
      } catch (error) {
        reject(error);
        return;
      }

      try {
        await ensureNodeRuntimeForWindowsShims(onProgress);
      } catch {
        // Best-effort â€” PATH fallback still helps for new terminals
      }

      // Add Atlas prefix to user PATH so CLIs are available in new terminals
      try {
        await ensurePrefixOnPath(onProgress);
      } catch {
        // Best-effort — don't fail the install if PATH update fails
      }

      if (binaryPath) {
        onProgress?.({ type: 'complete', message: `${npmPackage} installed successfully.`, binaryPath });
        resolve({ success: true, binaryPath });
      } else {
        onProgress?.({ type: 'complete', message: `${npmPackage} installed (binary not found in expected location, but may still work).` });
        resolve({ success: true, binaryPath: null });
      }
    });
  });
}

/**
 * Map package key to expected binary name.
 */
function getBinaryName(packageKey) {
  switch (packageKey) {
    case 'claude-code': return 'claude';
    case 'codex': return 'codex';
    case 'gemini-cli': return 'gemini';
    default: return packageKey;
  }
}

function getCodexPlatformMetadata(platform = process.platform, arch = process.arch) {
  if ((platform === 'darwin' || platform === 'linux') && arch !== 'x64' && arch !== 'arm64') {
    return null;
  }

  if (platform === 'darwin') {
    return arch === 'arm64'
      ? { targetTriple: 'aarch64-apple-darwin', aliasPackage: '@openai/codex-darwin-arm64' }
      : { targetTriple: 'x86_64-apple-darwin', aliasPackage: '@openai/codex-darwin-x64' };
  }

  if (platform === 'linux') {
    return arch === 'arm64'
      ? { targetTriple: 'aarch64-unknown-linux-musl', aliasPackage: '@openai/codex-linux-arm64' }
      : { targetTriple: 'x86_64-unknown-linux-musl', aliasPackage: '@openai/codex-linux-x64' };
  }

  if (platform === 'win32') {
    return arch === 'arm64'
      ? { targetTriple: 'aarch64-pc-windows-msvc', aliasPackage: '@openai/codex-win32-arm64' }
      : { targetTriple: 'x86_64-pc-windows-msvc', aliasPackage: '@openai/codex-win32-x64' };
  }

  return null;
}

function getCodexPackageRoot(prefix = getInstallPrefix()) {
  return getCodexPackageRootCandidates(prefix)[0];
}

function getCodexPackageRootCandidates(prefix = getInstallPrefix(), platform = process.platform) {
  const candidates = [];
  if (platform === 'win32') {
    candidates.push(path.join(prefix, 'node_modules', '@openai', 'codex'));
  }
  candidates.push(path.join(prefix, 'lib', 'node_modules', '@openai', 'codex'));
  candidates.push(path.join(prefix, 'node_modules', '@openai', 'codex'));
  return [...new Set(candidates)];
}

function getCodexRuntimeAliasInstallSpec(prefix = getInstallPrefix(), platform = process.platform, arch = process.arch) {
  const metadata = getCodexPlatformMetadata(platform, arch);
  if (!metadata) {
    return null;
  }

  for (const codexPackageRoot of getCodexPackageRootCandidates(prefix, platform)) {
    const codexPackagePath = path.join(codexPackageRoot, 'package.json');
    try {
      const pkg = JSON.parse(fsSync.readFileSync(codexPackagePath, 'utf8'));
      const aliasSpec = pkg?.optionalDependencies?.[metadata.aliasPackage];
      if (!aliasSpec || typeof aliasSpec !== 'string') {
        continue;
      }
      return `${metadata.aliasPackage}@${aliasSpec}`;
    } catch {
      // Try the next layout.
    }
  }

  return null;
}

function hasCodexRuntimePackage(prefix = getInstallPrefix(), platform = process.platform, arch = process.arch) {
  const metadata = getCodexPlatformMetadata(platform, arch);
  if (!metadata) {
    return false;
  }

  const aliasDirName = metadata.aliasPackage.split('/')[1];
  const candidates = [
    ...getCodexPackageRootCandidates(prefix, platform).map((codexPackageRoot) =>
      path.join(codexPackageRoot, 'node_modules', '@openai', aliasDirName, 'package.json')
    ),
    path.join(prefix, 'lib', 'node_modules', '@openai', aliasDirName, 'package.json'),
    path.join(prefix, 'node_modules', '@openai', aliasDirName, 'package.json'),
  ];

  for (const aliasPackageJson of candidates) {
    try {
      fsSync.accessSync(aliasPackageJson, fsSync.constants.R_OK);
      return true;
    } catch {
      // Try the next layout.
    }
  }

  return false;
}

function resolveWindowsCodexExecutablePath(
  binaryPath,
  { platform = process.platform, arch = process.arch } = {},
) {
  if (platform !== 'win32' || !binaryPath) {
    return binaryPath;
  }

  const candidate = path.normalize(String(binaryPath).trim());
  const normalizedLower = candidate.toLowerCase();
  if (normalizedLower.includes(`${path.sep}vendor${path.sep}`)) {
    return candidate;
  }

  const basename = path.basename(candidate).toLowerCase();
  if (basename !== 'codex' && basename !== 'codex.cmd' && basename !== 'codex.exe') {
    return candidate;
  }

  const shimDir = path.dirname(candidate);
  const prefixRoots = [shimDir];
  if (
    path.basename(shimDir).toLowerCase() === '.bin'
    && path.basename(path.dirname(shimDir)).toLowerCase() === 'node_modules'
  ) {
    prefixRoots.push(path.dirname(path.dirname(shimDir)));
  }

  const archSuffix = arch === 'arm64' ? 'arm64' : 'x64';
  const vendorArch = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const nativeCandidates = [];
  for (const prefixRoot of prefixRoots) {
    for (const codexPackageRoot of getCodexPackageRootCandidates(prefixRoot, platform)) {
      nativeCandidates.push(
        path.join(
          codexPackageRoot,
          'node_modules',
          '@openai',
          `codex-win32-${archSuffix}`,
          'vendor',
          vendorArch,
          'codex',
          'codex.exe',
        )
      );
    }
  }

  for (const nativeCandidate of nativeCandidates) {
    try {
      fsSync.accessSync(nativeCandidate, fsSync.constants.X_OK);
      return nativeCandidate;
    } catch {
      // Try the next candidate.
    }
  }

  const extension = path.extname(candidate).toLowerCase();
  if (!extension) {
    for (const siblingCandidate of [`${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`]) {
      try {
        fsSync.accessSync(siblingCandidate, fsSync.constants.F_OK);
        return siblingCandidate;
      } catch {
        // Try the next sibling shim.
      }
    }
  }

  return candidate;
}

function verifyCodexBinary(binaryPath, { env = process.env } = {}) {
  if (!binaryPath) {
    return { ok: false, error: 'Codex binary not found after install.' };
  }

  const executablePath = resolveWindowsCodexExecutablePath(binaryPath);

  const attempts = [];
  if (isWindowsSandboxEnvironment(env)) {
    attempts.push(['--dangerously-bypass-approvals-and-sandbox', '--version']);
    attempts.push(['--dangerously-bypass-approvals-and-sandbox', '--help']);
  }
  attempts.push(['--version']);
  attempts.push(['--help']);

  let lastError = null;
  for (const args of attempts) {
    try {
      execFileSync(executablePath, args, {
        env,
        stdio: 'pipe',
        timeout: 15000,
        windowsHide: true,
      });
      return { ok: true, error: null };
    } catch (error) {
      lastError = error;
    }
  }

  const stderr = String(lastError?.stderr || '').trim();
  const stdout = String(lastError?.stdout || '').trim();
  const status = Number.isInteger(lastError?.status) ? ` (exit code ${lastError.status})` : '';
  let message = stderr || stdout || `${lastError?.message || 'Codex failed runtime validation.'}${status}`;

  if (process.platform === 'win32' && isWindowsSandboxEnvironment(env)) {
    const lower = message.toLowerCase();
    if (lower.includes('sandbox setup is missing') || lower.includes('setup helper')) {
      message += ' Windows Sandbox detected; Codex internal sandbox setup is not available, so Atlas should run Codex with internal sandbox bypassed.';
    }
  }

  return { ok: false, error: message };
}

async function installCodexRuntimeAlias({ npm, prefix, spawnEnv, onProgress }) {
  const aliasInstallSpec = getCodexRuntimeAliasInstallSpec(prefix);
  if (!aliasInstallSpec) {
    throw new Error('Unable to resolve Codex platform runtime package.');
  }

  onProgress?.({ type: 'progress', message: `Installing missing Codex runtime (${aliasInstallSpec})...` });

  const spawnArgs = [
    ...npm.args,
    'install', '-g',
    '--prefix', prefix,
    aliasInstallSpec,
  ];

  await new Promise((resolve, reject) => {
    const proc = spawn(npm.cmd, spawnArgs, {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: shouldUseShellForNpm(npm.source, process.platform),
      windowsHide: true,
    });

    let stderr = '';

    proc.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        onProgress?.({ type: 'progress', message: line });
      }
    });

    proc.stderr.on('data', (data) => {
      const line = data.toString().trim();
      stderr += `${line}\n`;
      if (line && !line.startsWith('npm warn')) {
        onProgress?.({ type: 'progress', message: line });
      }
    });

    proc.on('error', (error) => {
      reject(new Error(`Failed to install Codex runtime package: ${error.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Codex runtime package install exited with code ${code}. ${stderr.slice(-500)}`));
        return;
      }
      resolve();
    });
  });
}

async function ensureHealthyInstall(packageKey, { npm, prefix, binaryPath, onProgress, spawnEnv }) {
  if (packageKey !== 'codex') {
    return;
  }

  if (!hasCodexRuntimePackage(prefix)) {
    await installCodexRuntimeAlias({ npm, prefix, spawnEnv, onProgress });
  }

  let verification = verifyCodexBinary(binaryPath, { env: spawnEnv });
  if (!verification.ok && shouldRepairCodexWindowsRuntime(verification)) {
    onProgress?.({
      type: 'progress',
      message: 'Codex requires the Microsoft Visual C++ runtime on this Windows machine. Installing it now...',
    });
    await installVisualCppRedistributable(onProgress);
    verification = verifyCodexBinary(binaryPath, { env: spawnEnv });
  }

  if (!verification.ok) {
    throw new Error(`Codex install is incomplete: ${verification.error}`);
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

function parseSha256Digest(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().startsWith('sha256:')
    ? raw.slice('sha256:'.length)
    : raw;
  return /^[a-f0-9]{64}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

function getVisualCppRedistributableUrl(platform = process.platform, arch = process.arch) {
  if (platform !== 'win32') {
    return null;
  }

  // Microsoft documents that the x64 package includes both x64 and ARM64 binaries.
  if (arch === 'x64' || arch === 'arm64') {
    return VISUAL_CPP_REDIST_URLS.x64;
  }

  if (arch === 'ia32' || arch === 'x86') {
    return VISUAL_CPP_REDIST_URLS.x86;
  }

  return null;
}

function shouldRepairCodexWindowsRuntime(verification, platform = process.platform) {
  if (platform !== 'win32' || verification?.ok) {
    return false;
  }

  const message = String(verification?.error || '').toLowerCase();
  return (
    message.includes('exit code 3221225781')
    || message.includes('exit code -1073741515')
    || message.includes('status_dll_not_found')
    || message.includes('vcruntime140.dll')
    || message.includes('msvcp140.dll')
    || message.includes('api-ms-win-crt')
  );
}

async function installVisualCppRedistributable(
  onProgress,
  {
    platform = process.platform,
    arch = process.arch,
    downloadImpl = downloadFile,
    spawnImpl = spawn,
    tempDir = os.tmpdir(),
  } = {},
) {
  const downloadUrl = getVisualCppRedistributableUrl(platform, arch);
  if (!downloadUrl) {
    throw new Error(`No Visual C++ Redistributable installer is defined for ${platform}/${arch}.`);
  }

  const installerName = downloadUrl.split('/').pop() || 'vc_redist.exe';
  const installerPath = path.join(tempDir, installerName);
  onProgress?.({
    type: 'progress',
    message: `Downloading Microsoft Visual C++ Redistributable (${installerName})...`,
  });
  await downloadImpl(downloadUrl, installerPath);

  try {
    onProgress?.({
      type: 'progress',
      message: 'Installing Microsoft Visual C++ Redistributable...',
    });

    const exitCode = await new Promise((resolve, reject) => {
      const proc = spawnImpl(installerPath, ['/install', '/quiet', '/norestart'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stderr = '';
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to launch Visual C++ Redistributable installer: ${error.message}`));
      });

      proc.on('close', (code) => {
        if (!VISUAL_CPP_REDIST_SUCCESS_CODES.has(code)) {
          reject(new Error(`Visual C++ Redistributable installer exited with code ${code}. ${stderr.trim()}`.trim()));
          return;
        }
        resolve(code);
      });
    });

    onProgress?.({
      type: 'progress',
      message: exitCode === 3010
        ? 'Microsoft Visual C++ Redistributable installed; Windows reported a restart may be required.'
        : 'Microsoft Visual C++ Redistributable is ready.',
    });

    return { success: true, exitCode };
  } finally {
    await fs.unlink(installerPath).catch(() => {});
  }
}

/**
 * Check the install prefix for an installed binary.
 * npm install -g --prefix layout varies:
 *   Windows system npm:  <prefix>/<name>.cmd  (flat)
 *   Windows local npm:   <prefix>/node_modules/.bin/<name>.cmd
 *   Unix:                <prefix>/bin/<name>
 */
function findInstalledBinary(binaryName) {
  const prefix = getInstallPrefix();
  const isWindows = process.platform === 'win32';

  const candidates = [];
  if (isWindows) {
    // Flat layout (system npm on Windows)
    candidates.push(
      path.join(prefix, `${binaryName}.cmd`),
      path.join(prefix, `${binaryName}.ps1`),
      path.join(prefix, binaryName),
    );
    // Nested layout (local/downloaded npm)
    candidates.push(
      path.join(prefix, 'node_modules', '.bin', `${binaryName}.cmd`),
      path.join(prefix, 'node_modules', '.bin', binaryName),
    );
  }
  // Unix layout
  candidates.push(
    path.join(prefix, 'bin', binaryName),
  );

  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate);
      return candidate;
    } catch {
      // Not found
    }
  }
  return null;
}

/**
 * Get the binary search paths that adapters should check.
 */
function getAdapterSearchPaths(binaryName) {
  const prefix = getInstallPrefix();
  const isWindows = process.platform === 'win32';

  const paths = [];
  if (isWindows) {
    // Flat layout (system npm on Windows)
    paths.push(path.join(prefix, `${binaryName}.cmd`));
    paths.push(path.join(prefix, binaryName));
    // Nested layout
    paths.push(path.join(prefix, 'node_modules', '.bin', `${binaryName}.cmd`));
    paths.push(path.join(prefix, 'node_modules', '.bin', binaryName));
  }
  // Unix layout
  paths.push(path.join(prefix, 'bin', binaryName));
  return paths;
}

function getPathEntriesForPrefix(prefix = getInstallPrefix(), platform = process.platform) {
  if (platform === 'win32') {
    return [
      prefix,
      path.join(prefix, 'node_modules', '.bin'),
    ];
  }

  return [
    path.join(prefix, 'bin'),
  ];
}

function getWindowsShimNodeTargets(prefix = getInstallPrefix(), platform = process.platform) {
  if (platform !== 'win32') {
    return [];
  }

  return getPathEntriesForPrefix(prefix, platform).map((entry) => path.join(entry, 'node.exe'));
}

function shouldUseShellForNpm(npmSource, platform = process.platform) {
  // On macOS/Linux, system npm can be executed directly and shell mode breaks
  // --prefix paths that contain spaces, such as "Library/Application Support".
  // Windows still benefits from shell mode for resolving npm.cmd from PATH.
  return npmSource === 'system' && platform === 'win32';
}

async function ensureNodeRuntimeForWindowsShims(onProgress) {
  if (process.platform !== 'win32') {
    return;
  }

  const sourceNodePath = process.execPath;
  if (path.basename(sourceNodePath).toLowerCase() !== 'node.exe') {
    onProgress?.({
      type: 'progress',
      message: `Skipping shim node.exe copy because process.execPath is ${sourceNodePath}.`,
    });
    return;
  }

  try {
    await fs.access(sourceNodePath);
  } catch {
    onProgress?.({
      type: 'progress',
      message: `Skipping shim node.exe copy because bundled Node was not found at ${sourceNodePath}.`,
    });
    return;
  }

  for (const targetPath of getWindowsShimNodeTargets()) {
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourceNodePath, targetPath);
      onProgress?.({
        type: 'progress',
        message: `Copied bundled node.exe to ${targetPath}.`,
      });
    } catch (error) {
      onProgress?.({
        type: 'progress',
        message: `Warning: Failed to copy bundled node.exe to ${targetPath}: ${error.message}`,
      });
    }
  }
}

async function ensureWindowsUserEnvironmentVariable(name, value, onProgress) {
  if (process.platform !== 'win32') {
    process.env[name] = value;
    return;
  }

  const scriptPath = path.join(os.tmpdir(), `atlas-env-${name.toLowerCase()}.ps1`);
  const escapedName = name.replace(/'/g, "''");
  const escapedValue = value.replace(/'/g, "''");
  const psScript = [
    `$name = '${escapedName}'`,
    `$value = '${escapedValue}'`,
    `$current = [Environment]::GetEnvironmentVariable($name, 'User')`,
    `if ($current -eq $value) {`,
    `  Write-Output 'already'`,
    `} else {`,
    `  [Environment]::SetEnvironmentVariable($name, $value, 'User')`,
    `  Add-Type -TypeDefinition @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public static class AtlasEnvironmentRefresh {`,
    `  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]`,
    `  public static extern IntPtr SendMessageTimeout(`,
    `    IntPtr hWnd,`,
    `    uint Msg,`,
    `    UIntPtr wParam,`,
    `    string lParam,`,
    `    uint fuFlags,`,
    `    uint uTimeout,`,
    `    out UIntPtr lpdwResult`,
    `  );`,
    `}`,
    `"@`,
    `  [UIntPtr]$resultPtr = [UIntPtr]::Zero`,
    `  [void][AtlasEnvironmentRefresh]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$resultPtr)`,
    `  Write-Output 'updated'`,
    `}`,
  ].join('\r\n');

  await fs.writeFile(scriptPath, psScript, 'utf8');
  try {
    const result = execFileSync(
      getWindowsPowerShellPath(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
    ).trim();
    process.env[name] = value;
    if (result === 'updated') {
      onProgress?.({
        type: 'progress',
        message: `Configured user environment variable ${name}.`,
      });
    }
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
  }
}

async function ensureWindowsUserPathEntries(pathEntries, onProgress, successMessage) {
  const scriptPath = path.join(os.tmpdir(), 'atlas-path-update.ps1');
  const escapedEntries = pathEntries.map((entry) => `'${entry.replace(/'/g, "''")}'`).join(', ');
  const psScript = [
    `$entries = @(${escapedEntries})`,
    `$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')`,
    `$currentEntries = if ($userPath) { $userPath.Split(';') } else { @() }`,
    `$missingEntries = @($entries | Where-Object { $_ -and ($currentEntries -notcontains $_) })`,
    `if ($missingEntries.Count -eq 0) {`,
    `  Write-Output 'already'`,
    `} else {`,
    `  $combinedEntries = @($currentEntries + $missingEntries | Where-Object { $_ })`,
    `  $newPath = ($combinedEntries -join ';')`,
    `  [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')`,
    `  Add-Type -TypeDefinition @"`,
    `using System;`,
    `using System.Runtime.InteropServices;`,
    `public static class AtlasEnvironmentRefresh {`,
    `  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]`,
    `  public static extern IntPtr SendMessageTimeout(`,
    `    IntPtr hWnd,`,
    `    uint Msg,`,
    `    UIntPtr wParam,`,
    `    string lParam,`,
    `    uint fuFlags,`,
    `    uint uTimeout,`,
    `    out UIntPtr lpdwResult`,
    `  );`,
    `}`,
    `"@`,
    `  [UIntPtr]$resultPtr = [UIntPtr]::Zero`,
    `  [void][AtlasEnvironmentRefresh]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$resultPtr)`,
    `  Write-Output 'added'`,
    `}`,
  ].join('\r\n');

  await fs.writeFile(scriptPath, psScript, 'utf8');
  try {
    const result = execFileSync(
      getWindowsPowerShellPath(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
    ).trim();

    if (result === 'added') {
      onProgress?.({
        type: 'progress',
        message: successMessage,
      });
    }
  } finally {
    await fs.unlink(scriptPath).catch(() => {});
  }
}

async function getLatestPortableGitAsset() {
  const release = await httpsGetJson(GIT_FOR_WINDOWS_RELEASE_API);
  const desiredSuffix = process.arch === 'arm64' ? '-arm64.7z.exe' : '-64-bit.7z.exe';
  const asset = (release.assets || []).find((entry) =>
    typeof entry?.name === 'string'
    && entry.name.startsWith('PortableGit-')
    && entry.name.endsWith(desiredSuffix)
  );

  if (!asset?.browser_download_url) {
    throw new Error(`Portable Git asset not found for ${process.arch}`);
  }

  const digestSha256 = parseSha256Digest(
    asset.digestSha256 || asset.digest_sha256 || asset.digest || null
  );
  if (!digestSha256) {
    throw new Error(`Portable Git asset ${asset.name} is missing a trusted SHA-256 digest`);
  }

  return {
    ...asset,
    digestSha256,
  };
}

async function extractPortableGit(archivePath, destinationRoot) {
  await fs.rm(destinationRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destinationRoot), { recursive: true });

  await new Promise((resolve, reject) => {
    const proc = spawn(archivePath, ['-y', `-o${destinationRoot}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Portable Git extraction failed with code ${code}. ${stderr.slice(-500)}`));
      }
    });
  });
}

async function ensureGitBashForClaude(onProgress) {
  if (process.platform !== 'win32') {
    return null;
  }

  let bashPath = findExistingGitBashPath();
  if (!bashPath) {
    const asset = await getLatestPortableGitAsset();
    const archivePath = path.join(os.tmpdir(), asset.name);
    const portableRoot = getPortableGitRoot();

    onProgress?.({
      type: 'progress',
      message: `Downloading official Portable Git (${asset.name})...`,
    });
    await downloadFile(asset.browser_download_url, archivePath);
    const actualSha256 = await sha256File(archivePath);
    if (actualSha256.toLowerCase() !== asset.digestSha256.toLowerCase()) {
      throw new Error(`Portable Git checksum mismatch for ${asset.name}`);
    }

    try {
      onProgress?.({
        type: 'progress',
        message: `Extracting Portable Git to ${portableRoot}...`,
      });
      await extractPortableGit(archivePath, portableRoot);
    } finally {
      await fs.unlink(archivePath).catch(() => {});
    }

    bashPath = getPortableGitBashPath(portableRoot);
    try {
      await fs.access(bashPath);
    } catch {
      throw new Error(`Portable Git extracted, but bash.exe was not found at ${bashPath}`);
    }
  }

  await ensureWindowsUserEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', bashPath, onProgress);

  const portableRoot = getPortableGitRoot();
  if (bashPath.startsWith(portableRoot)) {
    await ensureWindowsUserPathEntries(
      [getPortableGitCmdPath(portableRoot)],
      onProgress,
      `Added Portable Git to user PATH (${getPortableGitCmdPath(portableRoot)}). New terminals will have access.`,
    );
  }

  onProgress?.({
    type: 'progress',
    message: `Git Bash ready for Claude Code at ${bashPath}.`,
  });

  return bashPath;
}

async function installClaudeCodeWithWindowsPrereqs(onProgress) {
  let pendingCompleteEvent = null;

  const result = await installCLI('claude-code', (event) => {
    if (event?.type === 'complete') {
      pendingCompleteEvent = event;
      return;
    }
    onProgress?.(event);
  });

  await ensureGitBashForClaude(onProgress);

  if (pendingCompleteEvent) {
    onProgress?.(pendingCompleteEvent);
  }

  return result;
}

// ---------------------------------------------------------------------------
// PATH management
// ---------------------------------------------------------------------------

/**
 * Ensure the Atlas CLI prefix directory is on the user's PATH.
 * - Windows: uses PowerShell [Environment]::SetEnvironmentVariable (User scope, no admin)
 * - macOS: appends to ~/.zprofile + ~/.zshrc (login + interactive shells)
 * - Linux: appends to ~/.bashrc and ~/.zshrc if they exist
 * Only new terminal sessions pick up the change.
 */
async function ensurePrefixOnPath(onProgress) {
  const prefix = getInstallPrefix();
  const pathEntries = getPathEntriesForPrefix(prefix);

  if (process.platform === 'win32') {
    await ensureWindowsUserPathEntries(
      pathEntries,
      onProgress,
      `Added CLI install directories to user PATH (${pathEntries.join(', ')}). New terminals will have access.`,
    );
  } else {
    // Unix/macOS: append export line to shell profiles
    const exportLine = `export PATH="${prefix}/bin:$PATH"`;
    const marker = '# AtlasEngine CLI tools';
    const homeDir = os.homedir();
    const isMac = process.platform === 'darwin';
    const profiles = getShellProfilesForPathSetup(homeDir, process.platform);

    // Track which shell families we've already updated so we don't
    // write to both .zshrc AND .zprofile if one already has the marker.
    const updatedShells = new Set();

    for (const profile of profiles) {
      const shell = path.basename(profile).startsWith('.zsh') ? 'zsh' : 'bash';
      if (updatedShells.has(shell)) continue;

      try {
        let content = '';
        try {
          content = await fs.readFile(profile, 'utf8');
        } catch {
          // On macOS, .zprofile may not exist but zsh is the default shell.
          // Create it so the PATH is available in Terminal.app login shells.
          if (isMac && (profile.endsWith('.zprofile') || profile.endsWith('.bash_profile'))) {
            content = ''; // Will create the file below
          } else {
            continue; // File doesn't exist on Linux — skip
          }
        }
        if (content.includes(marker)) {
          updatedShells.add(shell);
          continue; // Already added
        }
        await fs.appendFile(profile, `\n${marker}\n${exportLine}\n`);
        updatedShells.add(shell);
        onProgress?.({ type: 'progress', message: `Added CLI tools to PATH in ~/${path.basename(profile)}.` });
      } catch {
        // Best-effort
      }
    }
  }
}

/**
 * Get install status for all CLI tools.
 */
async function getInstallStatus() {
  const npmStatus = await checkNpmAvailability();
  const installed = {};

  for (const [key] of Object.entries(ALLOWED_PACKAGES)) {
    const binaryName = getBinaryName(key);
    const binaryPath = findInstalledBinary(binaryName);
    let isInstalled = !!binaryPath;

    if (key === 'codex' && binaryPath) {
      const health = verifyCodexBinary(binaryPath, { env: buildNpmSpawnEnv() });
      isInstalled = health.ok;
    }

    installed[key] = { installed: isInstalled, binaryPath };
  }

  return {
    npmAvailable: npmStatus.available,
    npmSource: npmStatus.source,
    installableTools: Object.keys(ALLOWED_PACKAGES),
    installed,
  };
}

export default {
  ALLOWED_PACKAGES,
  checkNpmAvailability,
  ensureNpm,
  installCLI,
  installClaudeCodeWithWindowsPrereqs,
  getInstallPrefix,
  getPortableGitRoot,
  getPortableGitBashPath,
  getPortableGitCmdPath,
  getShellProfilesForPathSetup,
  getGitBashPathCandidates,
  findExistingGitBashPath,
  getWindowsPowerShellPath,
  isWindowsSandboxEnvironment,
  getPathEntriesForPrefix,
  getWindowsShimNodeTargets,
  shouldUseShellForNpm,
  parseSha256Digest,
  getVisualCppRedistributableUrl,
  shouldRepairCodexWindowsRuntime,
  installVisualCppRedistributable,
  getCodexPlatformMetadata,
  getCodexPackageRoot,
  getCodexPackageRootCandidates,
  getCodexRuntimeAliasInstallSpec,
  hasCodexRuntimePackage,
  resolveWindowsCodexExecutablePath,
  verifyCodexBinary,
  getAdapterSearchPaths,
  getInstallStatus,
  findInstalledBinary,
  getBinaryName,
  ensureNodeRuntimeForWindowsShims,
  ensureGitBashForClaude,
  ensurePrefixOnPath,
};
