import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { findClaudeBinary, isAtlasManagedClaudeBinaryPath } from '../claudeBinary.js';

const itWindows = process.platform === 'win32' ? it : it.skip;
const itNonWindows = process.platform === 'win32' ? it.skip : it;

let tempDir = null;
let originalAppData;
let originalAtlasDataDir;
let originalHome;
let originalUserProfile;
let originalPath;

beforeEach(() => {
  originalAppData = process.env.APPDATA;
  originalAtlasDataDir = process.env.ATLAS_DATA_DIR;
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalPath = process.env.PATH;
});

afterEach(async () => {
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  if (originalAtlasDataDir === undefined) delete process.env.ATLAS_DATA_DIR;
  else process.env.ATLAS_DATA_DIR = originalAtlasDataDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function writeCmd(filePath, { version, help }) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      '@echo off',
      'if "%1"=="--help" (',
      `  echo ${help}`,
      '  exit /b 0',
      ')',
      'if "%1"=="--version" (',
      `  echo ${version}`,
      '  exit /b 0',
      ')',
      'exit /b 0',
      '',
    ].join('\r\n'),
    'utf8'
  );
}

async function writePosixCli(filePath, { version, help }) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      `  printf '%s\\n' '${help}'`,
      '  exit 0',
      'fi',
      'if [ "$1" = "--version" ]; then',
      `  printf '%s\\n' '${version}'`,
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    'utf8'
  );
  await fs.chmod(filePath, 0o755);
}

describe('claudeBinary', () => {
  itNonWindows('ignores Atlas-managed Claude binaries found through PATH fallback', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-claude-binary-'));
    originalAtlasDataDir = process.env.ATLAS_DATA_DIR;
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;

    process.env.HOME = tempDir;
    const appDataDir = path.join(tempDir, 'AtlasEngine');
    process.env.ATLAS_DATA_DIR = appDataDir;
    const managedClaude = path.join(appDataDir, 'cli-tools', 'bin', 'claude');
    const desktopManagedClaude = path.join(
      tempDir,
      ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : ['.local', 'share']),
      'com.atlasengine.desktop',
      'cli-tools',
      'bin',
      'claude'
    );
    const machineClaude = path.join(tempDir, 'machine-bin', 'claude');
    await writePosixCli(managedClaude, {
      version: '1.0.120',
      help: 'Usage: claude --print --verbose --tools',
    });
    await writePosixCli(desktopManagedClaude, {
      version: '1.0.121',
      help: 'Usage: claude --print --verbose --tools',
    });
    await writePosixCli(machineClaude, {
      version: '2.1.89',
      help: 'Usage: claude --print --verbose --tools --session-id',
    });
    process.env.PATH = [
      path.dirname(managedClaude),
      path.dirname(desktopManagedClaude),
      path.dirname(machineClaude),
      '/usr/bin',
      '/bin',
    ].filter(Boolean).join(path.delimiter);

    const result = await findClaudeBinary({
      allowNpx: false,
      home: path.join(tempDir, 'empty-home'),
      preferredFlags: ['--tools'],
    });

    expect(isAtlasManagedClaudeBinaryPath(managedClaude)).toBe(true);
    expect(isAtlasManagedClaudeBinaryPath(desktopManagedClaude)).toBe(true);
    expect(result.binary).toBe(machineClaude);
    expect(result.supportsSessionId).toBe(true);
  });

  itNonWindows('prefers a compatible PATH Claude over an earlier stale PATH shim', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-claude-binary-'));
    process.env.HOME = path.join(tempDir, 'home');
    process.env.ATLAS_DATA_DIR = path.join(tempDir, 'atlas-data');

    const staleClaude = path.join(tempDir, 'old-bin', 'claude');
    const compatibleClaude = path.join(tempDir, 'new-bin', 'claude');
    await writePosixCli(staleClaude, {
      version: '1.0.120',
      help: 'Usage: claude --print --verbose',
    });
    await writePosixCli(compatibleClaude, {
      version: '2.1.89',
      help: 'Usage: claude --print --verbose --tools --session-id',
    });
    process.env.PATH = [
      path.dirname(staleClaude),
      path.dirname(compatibleClaude),
      '/usr/bin',
      '/bin',
    ].join(path.delimiter);

    const result = await findClaudeBinary({
      allowNpx: false,
      home: process.env.HOME,
      preferredFlags: ['--tools'],
    });

    expect(result.binary).toBe(compatibleClaude);
    expect(result.supportsTools).toBe(true);
    expect(result.supportsSessionId).toBe(true);
  });

  itWindows('prefers a newer compatible nvm Claude over a stale npm shim', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-claude-binary-'));
    process.env.APPDATA = path.join(tempDir, 'AppData', 'Roaming');

    const staleNpmClaude = path.join(process.env.APPDATA, 'npm', 'claude.cmd');
    const compatibleNvmClaude = path.join(process.env.APPDATA, 'nvm', 'v20.19.3', 'claude.cmd');
    await writeCmd(staleNpmClaude, {
      version: '1.0.120',
      help: 'Usage: claude --print --verbose',
    });
    await writeCmd(compatibleNvmClaude, {
      version: '2.1.131',
      help: 'Usage: claude --print --verbose --tools --setting-sources',
    });

    const result = await findClaudeBinary({
      allowNpx: false,
      home: tempDir,
      preferredFlags: ['--tools'],
    });

    expect(result.binary).toBe(compatibleNvmClaude);
    expect(result.args).toEqual([]);
  });

  itWindows('prefers a compatible PATH Claude over an earlier stale PATH shim', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-claude-binary-'));
    process.env.HOME = path.join(tempDir, 'home');
    process.env.USERPROFILE = process.env.HOME;
    process.env.ATLAS_DATA_DIR = path.join(tempDir, 'atlas-data');

    const staleClaude = path.join(tempDir, 'old-bin', 'claude.cmd');
    const compatibleClaude = path.join(tempDir, 'new-bin', 'claude.cmd');
    await writeCmd(staleClaude, {
      version: '1.0.120',
      help: 'Usage: claude --print --verbose',
    });
    await writeCmd(compatibleClaude, {
      version: '2.1.89',
      help: 'Usage: claude --print --verbose --tools --session-id',
    });
    process.env.PATH = [
      path.dirname(staleClaude),
      path.dirname(compatibleClaude),
      process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : null,
      process.env.SystemRoot,
    ].filter(Boolean).join(path.delimiter);

    const result = await findClaudeBinary({
      allowNpx: false,
      home: process.env.HOME,
      preferredFlags: ['--tools'],
    });

    expect(result.binary).toBe(compatibleClaude);
    expect(result.supportsTools).toBe(true);
    expect(result.supportsSessionId).toBe(true);
  });
});
