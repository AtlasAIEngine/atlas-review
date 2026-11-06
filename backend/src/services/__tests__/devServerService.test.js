import { describe, expect, it } from 'vitest';

import { buildSpawnEnv, shouldUseShellForPackageManager } from '../devServerService.js';

describe('devServerService spawn environment', () => {
  it('does not prepend the bundled Node path on macOS', () => {
    const originalPath = '/usr/local/bin:/usr/bin:/bin';

    const result = buildSpawnEnv(
      { PATH: originalPath },
      {
        platform: 'darwin',
        nodeExecPath: '/Applications/AtlasEngine.app/Contents/MacOS/node',
      },
    );

    expect(result.PATH).toBe(originalPath);
  });

  it('prepends the bundled Node path on Windows so npm shims can resolve node.exe', () => {
    const originalPath = 'C:\\Windows\\System32';

    const result = buildSpawnEnv(
      { PATH: originalPath },
      {
        platform: 'win32',
        nodeExecPath: 'C:\\Program Files\\AtlasEngine\\node.exe',
      },
    );

    expect(result.PATH).toBe(`C:\\Program Files\\AtlasEngine;${originalPath}`);
  });
});

describe('devServerService package manager shell usage', () => {
  it('uses shell mode only for system npm on Windows', () => {
    expect(shouldUseShellForPackageManager('system', 'win32')).toBe(true);
    expect(shouldUseShellForPackageManager('system', 'darwin')).toBe(false);
    expect(shouldUseShellForPackageManager('local', 'win32')).toBe(false);
  });
});
