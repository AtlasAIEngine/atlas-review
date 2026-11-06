import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import cliInstallService from '../cliInstallService.js';

describe('cliInstallService PATH entry selection', () => {
  it('includes both flat and nested Windows shim directories', () => {
    const prefix = 'C:\\Users\\test\\AppData\\Roaming\\AtlasEngine\\cli-tools';

    expect(cliInstallService.getPathEntriesForPrefix(prefix, 'win32')).toEqual([
      prefix,
      path.join(prefix, 'node_modules', '.bin'),
    ]);
  });

  it('uses the bin directory on Unix-like platforms', () => {
    const prefix = '/tmp/atlas/cli-tools';

    expect(cliInstallService.getPathEntriesForPrefix(prefix, 'linux')).toEqual([
      path.join(prefix, 'bin'),
    ]);
  });

  it('resolves Windows node.exe copy targets for npm shims', () => {
    const prefix = 'C:\\Users\\test\\AppData\\Roaming\\dev.atlasengine.desktop\\cli-tools';

    expect(cliInstallService.getWindowsShimNodeTargets(prefix, 'win32')).toEqual([
      path.join(prefix, 'node.exe'),
      path.join(prefix, 'node_modules', '.bin', 'node.exe'),
    ]);
  });

  it('derives the portable Git Bash and cmd paths under app data', () => {
    const root = 'C:\\Users\\test\\AppData\\Roaming\\dev.atlasengine.desktop\\portable-git';

    expect(cliInstallService.getPortableGitBashPath(root)).toBe(
      path.join(root, 'bin', 'bash.exe'),
    );
    expect(cliInstallService.getPortableGitCmdPath(root)).toBe(
      path.join(root, 'cmd'),
    );
  });

  it('prioritizes login shell profiles first on macOS', () => {
    const home = '/Users/tester';

    expect(cliInstallService.getShellProfilesForPathSetup(home, 'darwin')).toEqual([
      path.join(home, '.zprofile'),
      path.join(home, '.bash_profile'),
      path.join(home, '.zshrc'),
      path.join(home, '.bashrc'),
    ]);
  });

  it('uses shell mode only for system npm on Windows', () => {
    expect(cliInstallService.shouldUseShellForNpm('system', 'win32')).toBe(true);
    expect(cliInstallService.shouldUseShellForNpm('system', 'darwin')).toBe(false);
    expect(cliInstallService.shouldUseShellForNpm('system', 'linux')).toBe(false);
    expect(cliInstallService.shouldUseShellForNpm('local', 'win32')).toBe(false);
  });

  it('detects the Windows Sandbox utility account as an external sandbox host', () => {
    expect(cliInstallService.isWindowsSandboxEnvironment({
      USERNAME: 'WDAGUtilityAccount',
      USERPROFILE: 'C:\\Users\\WDAGUtilityAccount',
    }, 'win32')).toBe(true);
    expect(cliInstallService.isWindowsSandboxEnvironment({
      USERNAME: 'normal-user',
      USERPROFILE: 'C:\\Users\\normal-user',
    }, 'win32')).toBe(false);
  });

  it('parses sha256 digests from GitHub asset metadata', () => {
    expect(cliInstallService.parseSha256Digest('sha256:ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789'))
      .toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    expect(cliInstallService.parseSha256Digest('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'))
      .toBe('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    expect(cliInstallService.parseSha256Digest('')).toBeNull();
    expect(cliInstallService.parseSha256Digest('sha512:bad')).toBeNull();
  });

  it('returns the official Microsoft VC++ redist permalink for Windows x64 hosts', () => {
    expect(cliInstallService.getVisualCppRedistributableUrl('win32', 'x64')).toBe(
      'https://aka.ms/vc14/vc_redist.x64.exe',
    );
    expect(cliInstallService.getVisualCppRedistributableUrl('win32', 'arm64')).toBe(
      'https://aka.ms/vc14/vc_redist.x64.exe',
    );
    expect(cliInstallService.getVisualCppRedistributableUrl('linux', 'x64')).toBeNull();
  });

  it('flags missing Windows VC++ runtime crashes for Codex repair', () => {
    expect(cliInstallService.shouldRepairCodexWindowsRuntime({
      ok: false,
      error: 'Command failed: codex.exe --help (exit code 3221225781)',
    }, 'win32')).toBe(true);
    expect(cliInstallService.shouldRepairCodexWindowsRuntime({
      ok: false,
      error: 'Windows sandbox setup is missing or out of date',
    }, 'win32')).toBe(false);
    expect(cliInstallService.shouldRepairCodexWindowsRuntime({
      ok: true,
      error: null,
    }, 'win32')).toBe(false);
  });

  it('maps Codex platform runtime aliases for the current platform', () => {
    expect(cliInstallService.getCodexPlatformMetadata('darwin', 'arm64')).toEqual({
      targetTriple: 'aarch64-apple-darwin',
      aliasPackage: '@openai/codex-darwin-arm64',
    });
    expect(cliInstallService.getCodexPlatformMetadata('linux', 'x64')).toEqual({
      targetTriple: 'x86_64-unknown-linux-musl',
      aliasPackage: '@openai/codex-linux-x64',
    });
    expect(cliInstallService.getCodexPlatformMetadata('win32', 'x64')).toEqual({
      targetTriple: 'x86_64-pc-windows-msvc',
      aliasPackage: '@openai/codex-win32-x64',
    });
  });

  it('resolves the explicit Codex runtime alias install spec from package metadata', async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-codex-prefix-'));
    const codexDir = path.join(prefix, 'lib', 'node_modules', '@openai', 'codex');
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      path.join(codexDir, 'package.json'),
      JSON.stringify({
        name: '@openai/codex',
        version: '0.116.0',
        optionalDependencies: {
          '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.116.0-darwin-arm64',
        },
      }),
      'utf8',
    );

    expect(cliInstallService.getCodexRuntimeAliasInstallSpec(prefix, 'darwin', 'arm64')).toBe(
      '@openai/codex-darwin-arm64@npm:@openai/codex@0.116.0-darwin-arm64',
    );
  });

  it('resolves the Codex runtime alias from the Windows npm prefix layout', async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-codex-prefix-win-'));
    const codexDir = path.join(prefix, 'node_modules', '@openai', 'codex');
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(
      path.join(codexDir, 'package.json'),
      JSON.stringify({
        name: '@openai/codex',
        version: '0.116.0',
        optionalDependencies: {
          '@openai/codex-win32-x64': 'npm:@openai/codex@0.116.0-win32-x64',
        },
      }),
      'utf8',
    );

    expect(cliInstallService.getCodexRuntimeAliasInstallSpec(prefix, 'win32', 'x64')).toBe(
      '@openai/codex-win32-x64@npm:@openai/codex@0.116.0-win32-x64',
    );
  });

  it('detects a nested Windows Codex runtime package under the main package root', async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-codex-runtime-win-'));
    const runtimeDir = path.join(
      prefix,
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
    );
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(
      path.join(runtimeDir, 'package.json'),
      JSON.stringify({ name: '@openai/codex', version: '0.116.0-win32-x64' }),
      'utf8',
    );

    expect(cliInstallService.hasCodexRuntimePackage(prefix, 'win32', 'x64')).toBe(true);
  });

  it('resolves a native Windows Codex executable from a .cmd shim path', async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-codex-shim-win-'));
    const nativeExe = path.join(
      prefix,
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'codex',
      'codex.exe',
    );
    await fs.mkdir(path.dirname(nativeExe), { recursive: true });
    await fs.writeFile(nativeExe, '', 'utf8');

    expect(
      cliInstallService.resolveWindowsCodexExecutablePath(path.join(prefix, 'codex.cmd'), {
        platform: 'win32',
        arch: 'x64',
      }),
    ).toBe(nativeExe);
  });

  it('resolves a native Windows Codex executable from a nested .bin shim path', async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-codex-shim-nested-win-'));
    const nativeExe = path.join(
      prefix,
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'codex',
      'codex.exe',
    );
    await fs.mkdir(path.dirname(nativeExe), { recursive: true });
    await fs.writeFile(nativeExe, '', 'utf8');

    expect(
      cliInstallService.resolveWindowsCodexExecutablePath(
        path.join(prefix, 'node_modules', '.bin', 'codex.cmd'),
        {
          platform: 'win32',
          arch: 'x64',
        },
      ),
    ).toBe(nativeExe);
  });

  it('falls back from an extensionless Windows Codex npm shim to a sibling .cmd shim', async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-codex-shim-fallback-win-'));
    const extensionlessShim = path.join(prefix, 'codex');
    const cmdShim = `${extensionlessShim}.cmd`;
    await fs.writeFile(cmdShim, '@echo off\r\n', 'utf8');

    expect(
      cliInstallService.resolveWindowsCodexExecutablePath(extensionlessShim, {
        platform: 'win32',
        arch: 'x64',
      }),
    ).toBe(cmdShim);
  });

  it('treats a broken Codex shim as unhealthy even when the binary exists', async () => {
    const prefix = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-codex-health-'));
    const binDir = path.join(prefix, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const brokenCodex = path.join(binDir, 'codex');
    await fs.writeFile(
      brokenCodex,
      '#!/bin/sh\necho "Missing optional dependency @openai/codex-darwin-arm64" >&2\nexit 1\n',
      'utf8',
    );
    await fs.chmod(brokenCodex, 0o755);

    const result = cliInstallService.verifyCodexBinary(brokenCodex);
    expect(result.ok).toBe(false);
    if (process.platform === 'win32') {
      expect(result.error).toBeTruthy();
    } else {
      expect(result.error).toContain('Missing optional dependency');
    }
  });

  it('simulates installing the Microsoft VC++ runtime for a missing-DLL Codex repair', async () => {
    const progress = [];
    const downloads = [];
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-vcredist-'));

    const result = await cliInstallService.installVisualCppRedistributable(
      (event) => progress.push(event?.message || ''),
      {
        platform: 'win32',
        arch: 'x64',
        tempDir,
        downloadImpl: async (url, destinationPath) => {
          downloads.push({ url, destinationPath });
          await fs.writeFile(destinationPath, 'stub-installer', 'utf8');
        },
        spawnImpl: () => {
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          queueMicrotask(() => proc.emit('close', 0));
          return proc;
        },
      },
    );

    expect(result).toEqual({ success: true, exitCode: 0 });
    expect(downloads).toHaveLength(1);
    expect(downloads[0].url).toBe('https://aka.ms/vc14/vc_redist.x64.exe');
    expect(progress.some((message) => message.includes('Visual C++ Redistributable'))).toBe(true);
  });
});
