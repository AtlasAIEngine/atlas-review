import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectProjectAvailability, getDetectionMetadata } from '../linter/dotnetAdapter.js';
import { toRepoRelativePath } from '../linter/linterPathUtils.js';

const tempDirs = [];

function createTempProject() {
  const projectPath = mkdtempSync(join(tmpdir(), 'atlas-linter-'));
  tempDirs.push(projectPath);
  return projectPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('toRepoRelativePath', () => {
  it('normalizes Windows-style absolute paths to repo-relative paths case-insensitively', () => {
    expect(toRepoRelativePath('C:\\Repo\\src\\app.ts', 'c:\\repo')).toBe('src/app.ts');
  });

  it('leaves non-repo-prefixed paths unchanged after normalization', () => {
    expect(toRepoRelativePath('src\\app.ts', 'C:\\repo')).toBe('src/app.ts');
  });
});

describe('dotnetAdapter detection metadata', () => {
  it('finds nested solution and project files within the search depth', () => {
    const projectPath = createTempProject();
    const nestedDir = join(projectPath, 'src', 'Game', 'Core');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'Game.Core.csproj'), '<Project />', 'utf8');

    expect(detectProjectAvailability(projectPath)).toBe(true);
    expect(getDetectionMetadata(projectPath)).toEqual(expect.objectContaining({
      hasConfig: true,
      policyDefaultEligible: true,
      configLabel: 'src/Game/Core/Game.Core.csproj',
    }));
  });
});
