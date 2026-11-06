import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

const tempDirs = [];

async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function importAdapter() {
  return import('../linter/dotnetAdapter.js');
}

function createUnityReviewProfile(unityRoot) {
  return {
    stackFamily: 'unity',
    projectContext: {
      unityRoot,
    },
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileMock.mockReset();
  execFileSyncMock.mockImplementation((binary, args) => {
    if (binary === 'which' && Array.isArray(args) && args[0] === 'dotnet') {
      return '/usr/local/bin/dotnet\n';
    }
    throw new Error('missing binary');
  });
});

describe('dotnetAdapter Unity target selection', () => {
  it('returns null Unity context for non-Unity profiles', async () => {
    const { resolveUnityContext } = await importAdapter();

    expect(resolveUnityContext('/repo', null)).toBeNull();
    expect(resolveUnityContext('/repo', { stackFamily: 'generic', projectContext: { unityRoot: 'Assets' } })).toBeNull();
  });

  it('prefers project files inside the selected Unity root over sibling Unity-like roots', async () => {
    const { resolveDotnetBuildTarget } = await importAdapter();
    const projectPath = await makeTempDir('atlas-dotnet-target-');
    await fs.mkdir(path.join(projectPath, 'Project_BLACK', 'BLACK_Unity', 'ProjectSettings'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'Project_BLACK', 'BLACK_FMOD', 'ProjectSettings'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'Project_BLACK', 'BLACK_Unity', 'Assembly-CSharp.csproj'), '<Project />', 'utf8');
    await fs.writeFile(path.join(projectPath, 'Project_BLACK', 'BLACK_FMOD', 'Assembly-CSharp.csproj'), '<Project />', 'utf8');

    const target = resolveDotnetBuildTarget(
      projectPath,
      ['Project_BLACK/BLACK_Unity/Assets/Scripts/Player.cs'],
      { reviewProfile: createUnityReviewProfile('Project_BLACK/BLACK_Unity') }
    );

    expect(target).toEqual(expect.objectContaining({
      relativePath: 'Project_BLACK/BLACK_Unity/Assembly-CSharp.csproj',
      buildPath: 'Project_BLACK/BLACK_Unity/Assembly-CSharp.csproj',
    }));
  });

  it('builds the selected Unity project file instead of the whole repo', async () => {
    const { run } = await importAdapter();
    const projectPath = await makeTempDir('atlas-dotnet-run-');
    await fs.mkdir(path.join(projectPath, 'Project_BLACK', 'BLACK_Unity', 'ProjectSettings'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'Project_BLACK', 'BLACK_Unity', 'Assembly-CSharp.csproj'), '<Project />', 'utf8');
    execFileMock.mockImplementation((_binary, _args, _options, callback) => {
      callback(null, '', '');
      return { kill() {} };
    });

    await run(
      projectPath,
      ['Project_BLACK/BLACK_Unity/Assets/Scripts/Player.cs'],
      { reviewProfile: createUnityReviewProfile('Project_BLACK/BLACK_Unity') }
    );

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining([
      'build',
      'Project_BLACK/BLACK_Unity/Assembly-CSharp.csproj',
      '--no-restore',
      '--verbosity',
      'quiet',
    ]));
  });

  it('keeps valid diagnostics in the selected Unity root and skips sibling-root noise', async () => {
    const { parseDotnetOutput } = await importAdapter();
    const projectPath = await makeTempDir('atlas-dotnet-parse-');
    const resolvedProjectPath = realpathSync(projectPath);
    const output = [
      `${path.join(resolvedProjectPath, 'Project_BLACK', 'BLACK_Unity', 'Assets', 'Scripts', 'Player.cs')}(4,2): warning CA2000: Dispose objects before losing scope`,
      `${path.join(resolvedProjectPath, 'Project_BLACK', 'BLACK_FMOD', 'Assets', 'Scripts', 'Plugin.cs')}(6,3): warning CA1822: Member can be static`,
      `${path.join(resolvedProjectPath, 'Project_BLACK', 'BLACK_Unity', 'Assets', 'Scripts', 'Noise.cs')}(1,1): warning MSB3270: Mismatch between architecture`,
      `${path.join(resolvedProjectPath, 'Project_BLACK', 'BLACK_Unity', 'Assets', 'Scripts', 'EditorTool.cs')}(8,4): warning IDE0051: Remove unused private members`,
    ].join('\n');

    const findings = parseDotnetOutput(output, projectPath, {
      isUnity: true,
      unityRoot: 'Project_BLACK/BLACK_Unity',
    });

    expect(findings).toEqual([
      expect.objectContaining({
        file: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Player.cs',
        ruleId: 'CA2000',
      }),
      expect.objectContaining({
        file: 'Project_BLACK/BLACK_Unity/Assets/Scripts/EditorTool.cs',
        ruleId: 'IDE0051',
      }),
    ]);
  });

  it('does not apply Unity filtering when the run is not in Unity mode', async () => {
    const { parseDotnetOutput } = await importAdapter();
    const projectPath = await makeTempDir('atlas-dotnet-parse-generic-');
    const resolvedProjectPath = realpathSync(projectPath);
    const output = [
      `${path.join(resolvedProjectPath, 'src', 'Server.cs')}(2,1): warning MSB3277: Assembly version conflict`,
      `${path.join(resolvedProjectPath, 'other', 'Worker.cs')}(5,2): warning CA1822: Member can be static`,
    ].join('\n');

    const findings = parseDotnetOutput(output, projectPath, {
      isUnity: false,
      unityRoot: 'ignored/in/non-unity',
    });

    expect(findings).toEqual([
      expect.objectContaining({
        file: 'src/Server.cs',
        ruleId: 'MSB3277',
      }),
      expect.objectContaining({
        file: 'other/Worker.cs',
        ruleId: 'CA1822',
      }),
    ]);
  });

  it('parses compiler-global CSC diagnostics that reference a source file path', async () => {
    const { parseDotnetOutput } = await importAdapter();
    const projectPath = await makeTempDir('atlas-dotnet-parse-csc-');
    const resolvedProjectPath = realpathSync(projectPath);
    const missingFilePath = path.join(
      resolvedProjectPath,
      'Project_BLACK',
      'BLACK_Unity',
      'Assets',
      'BLACK',
      'MiniMap',
      'Scripts',
      'Signals',
      'ShowExitPortalsOnMapSignal.cs'
    );
    const output = `CSC : error CS2001: Source file '${missingFilePath}' could not be found. [${path.join(resolvedProjectPath, 'Project_BLACK', 'BLACK_Unity', 'Assembly-CSharp.csproj')}]`;

    const findings = parseDotnetOutput(output, projectPath, {
      isUnity: true,
      unityRoot: 'Project_BLACK/BLACK_Unity',
    });

    expect(findings).toEqual([
      expect.objectContaining({
        file: 'Project_BLACK/BLACK_Unity/Assets/BLACK/MiniMap/Scripts/Signals/ShowExitPortalsOnMapSignal.cs',
        line: 1,
        column: 1,
        ruleId: 'CS2001',
        severity: 'high',
      }),
    ]);
  });
});
