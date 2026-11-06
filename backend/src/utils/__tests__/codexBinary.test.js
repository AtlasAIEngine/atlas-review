import { describe, expect, it } from 'vitest';
import path from 'path';
import { getCodexBinaryCandidates } from '../codexBinary.js';

describe('codexBinary', () => {
  it('includes Mac GUI-safe Node manager install locations', () => {
    const homeDir = path.join(path.sep, 'Users', 'developer');
    const candidates = getCodexBinaryCandidates({
      platform: 'darwin',
      homeDir,
      env: { HOME: homeDir },
      npmGlobalBinPath: null,
    });

    expect(candidates).toContain('/opt/homebrew/bin/codex');
    expect(candidates).toContain('/usr/local/bin/codex');
    expect(candidates).toContain(path.join(homeDir, '.volta', 'bin', 'codex'));
    expect(candidates).toContain(path.join(homeDir, '.nvm', 'current', 'bin', 'codex'));
    expect(candidates).toContain(path.join(homeDir, '.asdf', 'shims', 'codex'));
    expect(candidates).toContain(path.join(homeDir, '.npm-global', 'bin', 'codex'));
  });

  it('includes Windows npm and version-manager install locations', () => {
    const homeDir = path.join('C:', 'Users', 'developer');
    const appData = path.join(homeDir, 'AppData', 'Roaming');
    const localAppData = path.join(homeDir, 'AppData', 'Local');
    const candidates = getCodexBinaryCandidates({
      platform: 'win32',
      homeDir,
      env: {
        HOME: homeDir,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
      },
      npmGlobalBinPath: null,
    });

    expect(candidates).toContain(path.join(appData, 'npm', 'codex.cmd'));
    expect(candidates).toContain(path.join(appData, 'npm', 'codex.ps1'));
    expect(candidates).toContain(path.join(localAppData, 'Volta', 'bin', 'codex.exe'));
    expect(candidates).toContain(path.join(homeDir, '.local', 'bin', 'codex.exe'));
  });
});
