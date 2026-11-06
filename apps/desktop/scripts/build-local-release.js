#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'fs';
import os from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { loadDesktopLocalEnv } from './load-local-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopDir = dirname(__dirname);
const projectRoot = resolve(desktopDir, '..', '..');
const tauriDir = join(desktopDir, 'src-tauri');
const packageJsonPath = join(desktopDir, 'package.json');
const updaterKeyPath = join(desktopDir, '.tauri_updater_key');
const signWindowsArtifactsScriptPath = join(desktopDir, 'scripts', 'sign-windows-artifacts.js');

loadDesktopLocalEnv();

function parseArgs(argv) {
  const options = {
    version: null,
    channel: 'stable',
    stagingDir: null,
    skipFrontend: false,
    target: null,
    requireAppleSigning: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--version':
      case '-v':
        options.version = next;
        index += 1;
        break;
      case '--channel':
      case '-c':
        options.channel = next;
        index += 1;
        break;
      case '--staging-dir':
      case '-o':
        options.stagingDir = next;
        index += 1;
        break;
      case '--skip-frontend':
        options.skipFrontend = true;
        break;
      case '--target':
      case '-t':
        options.target = next;
        index += 1;
        break;
      case '--apple-signing':
        options.requireAppleSigning = true;
        break;
      default:
        break;
    }
  }

  return options;
}

function commandName(base) {
  if (process.platform !== 'win32') {
    return base;
  }

  if (base === 'npm' || base === 'npx') {
    return `${base}.cmd`;
  }

  return base;
}

function run(command, args, options = {}) {
  const resolvedCommand = process.platform === 'win32' && command.endsWith('.cmd')
    ? process.env.ComSpec || 'cmd.exe'
    : command;
  const resolvedArgs = process.platform === 'win32' && command.endsWith('.cmd')
    ? ['/d', '/s', '/c', command, ...args]
    : args;

  return execFileSync(resolvedCommand, resolvedArgs, {
    cwd: options.cwd ?? desktopDir,
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env ?? process.env,
    encoding: options.capture ? 'utf8' : undefined,
  });
}

function getVersion(explicitVersion) {
  if (explicitVersion) {
    return explicitVersion;
  }

  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return pkg.version;
}

function getPlatformConfig(targetOverride) {
  if (targetOverride === 'aarch64-apple-darwin') {
    return {
      platformName: 'macos-aarch64',
      manifestPlatform: 'darwin-aarch64',
      target: 'aarch64-apple-darwin',
      bundleTargets: 'app,dmg',
      bundleDir: join(tauriDir, 'target', 'aarch64-apple-darwin', 'release', 'bundle'),
    };
  }

  if (targetOverride === 'x86_64-apple-darwin') {
    return {
      platformName: 'macos-x86_64',
      manifestPlatform: 'darwin-x86_64',
      target: 'x86_64-apple-darwin',
      bundleTargets: 'app',
      bundleDir: join(tauriDir, 'target', 'x86_64-apple-darwin', 'release', 'bundle'),
    };
  }

  if (targetOverride === 'x86_64-pc-windows-msvc') {
    return {
      platformName: 'windows-x86_64',
      manifestPlatform: 'windows-x86_64',
      target: 'x86_64-pc-windows-msvc',
      bundleTargets: 'nsis,msi',
      bundleDir: join(tauriDir, 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle'),
    };
  }

  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      return {
        platformName: 'macos-aarch64',
        manifestPlatform: 'darwin-aarch64',
        target: 'aarch64-apple-darwin',
        bundleTargets: 'app,dmg',
        bundleDir: join(tauriDir, 'target', 'aarch64-apple-darwin', 'release', 'bundle'),
      };
    }

    if (process.arch === 'x64') {
      return {
        platformName: 'macos-x86_64',
        manifestPlatform: 'darwin-x86_64',
        target: 'x86_64-apple-darwin',
        bundleTargets: 'app',
        bundleDir: join(tauriDir, 'target', 'x86_64-apple-darwin', 'release', 'bundle'),
      };
    }
  }

  if (process.platform === 'win32' && process.arch === 'x64') {
    return {
      platformName: 'windows-x86_64',
      manifestPlatform: 'windows-x86_64',
      target: 'x86_64-pc-windows-msvc',
      bundleTargets: 'nsis,msi',
      bundleDir: join(tauriDir, 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle'),
    };
  }

  throw new Error(`Unsupported local release target: ${targetOverride || `${process.platform}-${process.arch}`}`);
}

function ensureSigningKey(env) {
  if (!env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    console.warn(
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD is not set. ' +
      'If the updater key is encrypted, Tauri may wait for an interactive password prompt during signing.'
    );
  }

  if (env.TAURI_SIGNING_PRIVATE_KEY || env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    return env;
  }

  if (!existsSync(updaterKeyPath)) {
    throw new Error(`Missing updater private key at ${updaterKeyPath}`);
  }

  return {
    ...env,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(updaterKeyPath, 'utf8'),
  };
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function randomKeychainPassword() {
  return randomBytes(24).toString('base64');
}

function getAppleSigningInputs(env) {
  const certificateSource = env.APPLE_CERTIFICATE_PATH || env.APPLE_CERTIFICATE;

  return {
    certificateSource,
    certificatePassword: env.APPLE_CERTIFICATE_PASSWORD,
    appleId: env.APPLE_ID,
    applePassword: env.APPLE_PASSWORD,
    teamId: env.APPLE_TEAM_ID,
    keychainPassword: env.KEYCHAIN_PASSWORD || randomKeychainPassword(),
  };
}

function resolveAppleSigningConfig(config, options, env) {
  const isMacTarget = config.target === 'aarch64-apple-darwin' || config.target === 'x86_64-apple-darwin';
  if (!isMacTarget) {
    if (options.requireAppleSigning) {
      throw new Error('Apple signing can only be enabled for macOS targets.');
    }
    return { enabled: false };
  }

  const inputs = getAppleSigningInputs(env);
  const presentCount = [
    inputs.certificateSource,
    inputs.certificatePassword,
    inputs.appleId,
    inputs.applePassword,
    inputs.teamId,
  ].filter(Boolean).length;

  if (presentCount === 0) {
    if (options.requireAppleSigning) {
      throw new Error(
        'Missing local Apple signing configuration. Set APPLE_CERTIFICATE_PATH (or APPLE_CERTIFICATE), ' +
        'APPLE_CERTIFICATE_PASSWORD, APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID.'
      );
    }
    return { enabled: false };
  }

  const missing = [];
  if (!inputs.certificateSource) missing.push('APPLE_CERTIFICATE_PATH or APPLE_CERTIFICATE');
  if (!inputs.certificatePassword) missing.push('APPLE_CERTIFICATE_PASSWORD');
  if (!inputs.appleId) missing.push('APPLE_ID');
  if (!inputs.applePassword) missing.push('APPLE_PASSWORD');
  if (!inputs.teamId) missing.push('APPLE_TEAM_ID');

  if (missing.length > 0) {
    throw new Error(`Partial Apple signing configuration detected. Missing: ${missing.join(', ')}`);
  }

  return {
    enabled: true,
    ...inputs,
  };
}

function createAppleSigningSetup(config, options, env) {
  const signingConfig = resolveAppleSigningConfig(config, options, env);
  if (!signingConfig.enabled) {
    return {
      enabled: false,
      env,
      cleanup: () => {},
    };
  }

  const tempDir = mkdtempSync(join(os.tmpdir(), 'atlasengine-apple-signing-'));
  const keychainPath = join(tempDir, 'atlasengine-signing.keychain-db');
  let certificatePath = signingConfig.certificateSource;

  if (existsSync(signingConfig.certificateSource)) {
    certificatePath = resolve(signingConfig.certificateSource);
  } else {
    certificatePath = join(tempDir, 'apple-signing-certificate.p12');
    writeFileSync(certificatePath, Buffer.from(signingConfig.certificateSource, 'base64'));
  }

  const LEAKED_SIGNING_KEYCHAIN_RE = /atlasengine-apple-signing-[^/]+\/atlasengine-signing\.keychain-db$/;

  let originalDefaultKeychain = String(
    run('security', ['default-keychain', '-d', 'user'], { capture: true })
  ).trim().replace(/^"|"$/g, '');
  // If a prior crashed run left the default pointing at our temp keychain,
  // ignore it so cleanup doesn't "restore" the broken pointer.
  if (LEAKED_SIGNING_KEYCHAIN_RE.test(originalDefaultKeychain)) {
    originalDefaultKeychain = '';
  }
  const originalKeychainList = String(
    run('security', ['list-keychains', '-d', 'user'], { capture: true })
  )
    .split('\n')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    // Drop any leaked atlasengine-signing entries from prior crashed runs so
    // cleanup doesn't "restore" them back into the search list.
    .filter((entry) => !LEAKED_SIGNING_KEYCHAIN_RE.test(entry));

  const cleanup = () => {
    try {
      if (originalDefaultKeychain) {
        run('security', ['default-keychain', '-d', 'user', '-s', originalDefaultKeychain]);
      }
    } catch (error) {
      console.warn(`Failed to restore default keychain: ${error.message}`);
    }

    try {
      if (originalKeychainList.length > 0) {
        run('security', ['list-keychains', '-d', 'user', '-s', ...originalKeychainList]);
      }
    } catch (error) {
      console.warn(`Failed to restore keychain search list: ${error.message}`);
    }

    try {
      run('security', ['delete-keychain', keychainPath]);
    } catch {
      // Ignore cleanup failures; the temp directory removal below is best effort too.
    }

    rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    run('security', ['create-keychain', '-p', signingConfig.keychainPassword, keychainPath]);
    run('security', [
      'list-keychains',
      '-d',
      'user',
      '-s',
      keychainPath,
      ...originalKeychainList,
    ]);
    run('security', ['default-keychain', '-d', 'user', '-s', keychainPath]);
    run('security', ['unlock-keychain', '-p', signingConfig.keychainPassword, keychainPath]);
    run('security', ['set-keychain-settings', '-t', '3600', '-u', keychainPath]);
    run('security', [
      'import',
      certificatePath,
      '-k',
      keychainPath,
      '-P',
      signingConfig.certificatePassword,
      '-T',
      '/usr/bin/codesign',
      '-T',
      '/usr/bin/security',
    ]);
    run('security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      signingConfig.keychainPassword,
      keychainPath,
    ]);

    const identityOutput = String(
      run('security', ['find-identity', '-v', '-p', 'codesigning', keychainPath], { capture: true })
    );
    const match = identityOutput.match(/([0-9A-F]{40})\s+"([^"]*Developer ID Application[^"]*)"/);
    if (!match) {
      throw new Error(`No Developer ID Application certificate found in imported keychain.\n${identityOutput}`);
    }

    const signingHash = match[1];
    const signingIdentity = match[2];
    console.log(`Apple signing enabled for local macOS build with identity: ${signingIdentity}`);

    return {
      enabled: true,
      env: {
        ...env,
        APPLE_ID: signingConfig.appleId,
        APPLE_PASSWORD: signingConfig.applePassword,
        APPLE_TEAM_ID: signingConfig.teamId,
        APPLE_SIGNING_IDENTITY: signingIdentity,
        APPLE_SIGNING_IDENTITY_HASH: signingHash,
        APPLE_KEYCHAIN_PATH: keychainPath,
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function walkFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        stack.push(fullPath);
      } else if (stats.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function isMachOBinary(filePath) {
  try {
    const description = String(run('file', [filePath], { capture: true }));
    return description.includes('Mach-O');
  } catch {
    return false;
  }
}

function signEmbeddedMacBinaries(config, appleSigning, env) {
  if (!appleSigning.enabled) {
    return;
  }

  const resourcesDir = join(tauriDir, 'resources');
  if (!existsSync(resourcesDir)) {
    return;
  }

  const allFiles = walkFiles(resourcesDir);
  const nativeFiles = allFiles.filter((filePath) => isMachOBinary(filePath));
  if (nativeFiles.length === 0) {
    return;
  }

  console.log(`Pre-signing ${nativeFiles.length} embedded macOS binaries before bundling...`);
  for (const filePath of nativeFiles) {
    run('codesign', [
      '--force',
      '--sign',
      env.APPLE_SIGNING_IDENTITY_HASH || env.APPLE_SIGNING_IDENTITY,
      '--keychain',
      env.APPLE_KEYCHAIN_PATH,
      '--timestamp',
      filePath,
    ]);
  }
}

function copyIfExists(source, destination) {
  if (!existsSync(source)) {
    return false;
  }

  copyFileSync(source, destination);
  return true;
}

function collectArtifacts(config, version, stagingDir) {
  ensureDir(stagingDir);

  const copied = [];

  if (config.platformName === 'macos-aarch64') {
    const dmgSource = join(config.bundleDir, 'dmg', `AtlasEngine_${version}_aarch64.dmg`);
    if (copyIfExists(dmgSource, join(stagingDir, `AtlasEngine-${version}-macos-aarch64.dmg`))) {
      copied.push(`AtlasEngine-${version}-macos-aarch64.dmg`);
    }

    const updaterSource = join(config.bundleDir, 'macos', `AtlasEngine.app.tar.gz`);
    if (copyIfExists(updaterSource, join(stagingDir, `AtlasEngine_${version}_aarch64.app.tar.gz`))) {
      copied.push(`AtlasEngine_${version}_aarch64.app.tar.gz`);
    }

    const updaterSigSource = join(config.bundleDir, 'macos', `AtlasEngine.app.tar.gz.sig`);
    if (copyIfExists(updaterSigSource, join(stagingDir, `AtlasEngine_${version}_aarch64.app.tar.gz.sig`))) {
      copied.push(`AtlasEngine_${version}_aarch64.app.tar.gz.sig`);
    }
  } else if (config.platformName === 'macos-x86_64') {
    const appBundle = join(config.bundleDir, 'macos', 'AtlasEngine.app');
    const zipOutput = join(stagingDir, `AtlasEngine-${version}-macos-x86_64.zip`);
    if (existsSync(appBundle)) {
      run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, zipOutput], {
        cwd: desktopDir,
      });
      copied.push(`AtlasEngine-${version}-macos-x86_64.zip`);
    }

    const updaterSource = join(config.bundleDir, 'macos', `AtlasEngine.app.tar.gz`);
    if (copyIfExists(updaterSource, join(stagingDir, `AtlasEngine_${version}_x86_64.app.tar.gz`))) {
      copied.push(`AtlasEngine_${version}_x86_64.app.tar.gz`);
    }

    const updaterSigSource = join(config.bundleDir, 'macos', `AtlasEngine.app.tar.gz.sig`);
    if (copyIfExists(updaterSigSource, join(stagingDir, `AtlasEngine_${version}_x86_64.app.tar.gz.sig`))) {
      copied.push(`AtlasEngine_${version}_x86_64.app.tar.gz.sig`);
    }
  } else if (config.platformName === 'windows-x86_64') {
    const nsisDir = join(config.bundleDir, 'nsis');
    const msiDir = join(config.bundleDir, 'msi');

    copyIfExists(
      join(nsisDir, `AtlasEngine_${version}_x64-setup.exe`),
      join(stagingDir, `AtlasEngine-${version}-windows-x64-setup.exe`)
    ) && copied.push(`AtlasEngine-${version}-windows-x64-setup.exe`);

    copyIfExists(
      join(msiDir, `AtlasEngine_${version}_x64_en-US.msi`),
      join(stagingDir, `AtlasEngine-${version}-windows-x64.msi`)
    ) && copied.push(`AtlasEngine-${version}-windows-x64.msi`);

    copyIfExists(
      join(nsisDir, `AtlasEngine_${version}_x64-setup.exe`),
      join(stagingDir, `AtlasEngine-${version}-windows-x64-setup.exe`)
    ) && copied.push(`AtlasEngine-${version}-windows-x64-setup.exe`);

    copyIfExists(
      join(nsisDir, `AtlasEngine_${version}_x64-setup.exe.sig`),
      join(stagingDir, `AtlasEngine-${version}-windows-x64-setup.exe.sig`)
    ) && copied.push(`AtlasEngine-${version}-windows-x64-setup.exe.sig`);
  }

  if (copied.length === 0) {
    throw new Error(`No release artifacts found in ${config.bundleDir}`);
  }

  const metadata = {
    version,
    channel: options.channel,
    platform: config.platformName,
    target: config.target,
    generatedAt: new Date().toISOString(),
    artifacts: copied,
  };

  writeFileSync(join(stagingDir, `${config.platformName}.json`), JSON.stringify(metadata, null, 2));
}

const options = parseArgs(process.argv.slice(2));
const version = getVersion(options.version);
const config = getPlatformConfig(options.target);
const stagingDir = options.stagingDir
  ? resolve(options.stagingDir)
  : join(projectRoot, 'release-staging', version);

const env = ensureSigningKey({
  ...process.env,
  NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
});

const appleSigning = createAppleSigningSetup(config, options, env);
const buildEnv = appleSigning.env;

ensureDir(stagingDir);

try {
  if (!options.skipFrontend) {
    run(commandName('npm'), ['run', 'frontend:build'], { env: buildEnv });
  }

  run(commandName('npm'), ['run', 'bundle-backend', '--', '--target', config.target], { env: buildEnv });
  signEmbeddedMacBinaries(config, appleSigning, buildEnv);
  run(commandName('npx'), [
    'tauri',
    'build',
    '--target',
    config.target,
    '--bundles',
    config.bundleTargets,
    '--config',
    '{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":true}}',
  ], { env: buildEnv });

  if (config.platformName === 'windows-x86_64') {
    run(commandName('node'), [
      signWindowsArtifactsScriptPath,
      '--bundle-dir',
      config.bundleDir,
    ], { env: buildEnv });
  }

  collectArtifacts(config, version, stagingDir);
} finally {
  appleSigning.cleanup();
}

console.log(`Local ${config.platformName} release artifacts staged in ${stagingDir}`);
