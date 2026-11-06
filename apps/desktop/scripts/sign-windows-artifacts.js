#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const desktopDir = dirname(__dirname);

function parseArgs(argv) {
  const options = {
    bundleDir: null,
    timestampUrl: process.env.WINDOWS_TIMESTAMP_URL || null,
    certificatePath: process.env.WINDOWS_CERTIFICATE_PATH || null,
    certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD || null,
    certificateBase64: process.env.WINDOWS_CERTIFICATE_BASE64 || process.env.WINDOWS_CERTIFICATE || null,
    signToolPath: process.env.WINDOWS_SIGNTOOL_PATH || 'signtool.exe',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--bundle-dir':
      case '-b':
        options.bundleDir = next;
        index += 1;
        break;
      case '--timestamp-url':
        options.timestampUrl = next;
        index += 1;
        break;
      case '--certificate-path':
        options.certificatePath = next;
        index += 1;
        break;
      case '--certificate-password':
        options.certificatePassword = next;
        index += 1;
        break;
      case '--signtool-path':
        options.signToolPath = next;
        index += 1;
        break;
      default:
        break;
    }
  }

  if (!options.bundleDir) {
    throw new Error('Missing required --bundle-dir');
  }

  return options;
}

function run(command, args, options = {}) {
  const resolvedCommand = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
    ? process.env.ComSpec || 'cmd.exe'
    : command;
  const resolvedArgs = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
    ? ['/d', '/s', '/c', command, ...args]
    : args;

  execFileSync(resolvedCommand, resolvedArgs, {
    cwd: options.cwd ?? desktopDir,
    stdio: 'inherit',
    env: options.env ?? process.env,
  });
}

function findFirstFile(dirPath, extension) {
  if (!existsSync(dirPath)) {
    return null;
  }

  return readdirSync(dirPath)
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => join(dirPath, name))[0] ?? null;
}

function withCertificateFile(options, callback) {
  if (options.certificatePath) {
    return callback(resolve(options.certificatePath));
  }

  if (!options.certificateBase64) {
    return callback(null);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'atlasengine-windows-cert-'));
  const certificatePath = join(tempDir, 'windows-signing-certificate.pfx');

  try {
    writeFileSync(certificatePath, Buffer.from(options.certificateBase64, 'base64'));
    return callback(certificatePath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function shouldSign(options) {
  return Boolean(options.certificatePath || options.certificateBase64);
}

function ensureSigningInputs(options) {
  if (!shouldSign(options)) {
    return false;
  }

  if (!options.certificatePassword) {
    throw new Error('WINDOWS_CERTIFICATE_PASSWORD is required when Windows signing is enabled');
  }

  return true;
}

function signFile(options, certificatePath, filePath) {
  const args = [
    'sign',
    '/fd',
    'SHA256',
    '/f',
    certificatePath,
    '/p',
    options.certificatePassword,
  ];

  if (options.timestampUrl) {
    args.push('/tr', options.timestampUrl, '/td', 'SHA256');
  }

  args.push(filePath);
  run(options.signToolPath, args);
}

function verifyFile(options, filePath) {
  run(options.signToolPath, ['verify', '/pa', filePath]);
}

function getTauriCliCommand() {
  const localTauriCli = join(
    desktopDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
  );
  return existsSync(localTauriCli) ? localTauriCli : 'tauri';
}

function buildTauriSignerEnv() {
  const env = { ...process.env };
  if (env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_PRIVATE_KEY) {
    env.TAURI_PRIVATE_KEY = env.TAURI_SIGNING_PRIVATE_KEY;
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY_PATH && !env.TAURI_PRIVATE_KEY_PATH) {
    env.TAURI_PRIVATE_KEY_PATH = env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD && !env.TAURI_PRIVATE_KEY_PASSWORD) {
    env.TAURI_PRIVATE_KEY_PASSWORD = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  }
  return env;
}

function regenerateUpdaterSignature(filePath) {
  const signerEnv = buildTauriSignerEnv();
  if (!signerEnv.TAURI_PRIVATE_KEY && !signerEnv.TAURI_PRIVATE_KEY_PATH) {
    throw new Error('Missing Tauri updater private key for signature regeneration.');
  }

  const sigPath = `${filePath}.sig`;
  rmSync(sigPath, { force: true });

  run(
    getTauriCliCommand(),
    ['signer', 'sign', filePath],
    { env: signerEnv },
  );

  if (!existsSync(sigPath)) {
    throw new Error(`Failed to regenerate updater signature for ${filePath}`);
  }
}

function main() {
  if (process.platform !== 'win32') {
    console.log('Skipping Windows Authenticode signing on non-Windows host');
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  if (!ensureSigningInputs(options)) {
    console.log('Windows signing certificate not configured; skipping Authenticode signing');
    return;
  }

  const bundleDir = resolve(options.bundleDir);
  const nsisDir = join(bundleDir, 'nsis');
  const msiDir = join(bundleDir, 'msi');
  const exeFile = findFirstFile(nsisDir, '.exe');
  const msiFile = findFirstFile(msiDir, '.msi');

  if (!exeFile && !msiFile) {
    throw new Error(`No Windows installer artifacts found in ${bundleDir}`);
  }

  withCertificateFile(options, (certificatePath) => {
    if (!certificatePath || !existsSync(certificatePath)) {
      throw new Error('Resolved Windows certificate path does not exist');
    }

    if (exeFile) {
      console.log(`Signing ${exeFile}`);
      signFile(options, certificatePath, exeFile);
      verifyFile(options, exeFile);
      // Authenticode modifies the installer bytes, so the updater signature
      // must be regenerated from the final signed payload.
      regenerateUpdaterSignature(exeFile);
    }

    if (msiFile) {
      console.log(`Signing ${msiFile}`);
      signFile(options, certificatePath, msiFile);
      verifyFile(options, msiFile);
      regenerateUpdaterSignature(msiFile);
    }
  });
}

main();
