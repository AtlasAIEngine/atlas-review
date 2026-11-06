import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';

import { resolveWindowsCliExecutablePath } from '../windowsCliPaths.js';

describe('resolveWindowsCliExecutablePath', () => {
  it('prefers a sibling .cmd shim for Windows npm binaries', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-win-cli-'));
    const basePath = path.join(tempRoot, 'opencode');
    const cmdPath = `${basePath}.cmd`;

    await fs.writeFile(basePath, '#!/bin/sh\necho stub\n', 'utf8');
    await fs.writeFile(cmdPath, '@echo off\r\necho stub\r\n', 'utf8');

    expect(resolveWindowsCliExecutablePath(basePath, { platform: 'win32' })).toBe(cmdPath);
  });

  it('leaves non-Windows paths untouched', () => {
    expect(resolveWindowsCliExecutablePath('/usr/local/bin/opencode', { platform: 'darwin' })).toBe('/usr/local/bin/opencode');
  });
});
