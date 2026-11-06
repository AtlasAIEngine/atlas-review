import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
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
  return import('../linter/dotnetFormatAdapter.js');
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

describe('dotnetFormatAdapter', () => {
  it('is available for dotnet repos but disabled by default in starter policy metadata', async () => {
    const { getDetectionMetadata } = await importAdapter();
    const projectPath = await makeTempDir('atlas-dotnet-format-meta-');
    await fs.writeFile(path.join(projectPath, 'App.csproj'), '<Project />\n', 'utf8');

    expect(getDetectionMetadata(projectPath)).toEqual(expect.objectContaining({
      policyDefaultEligible: true,
      defaultEnabled: false,
      runtimeReady: true,
      effectiveMode: 'project_linter',
    }));
  });

  it('parses dotnet format report entries into findings', async () => {
    const { parseDotnetFormatReport } = await importAdapter();
    const projectPath = await makeTempDir('atlas-dotnet-format-parse-');
    const report = JSON.stringify([
      {
        FileName: 'Program.cs',
        FilePath: path.join(projectPath, 'Program.cs'),
        FileChanges: [
          {
            LineNumber: 1,
            CharNumber: 14,
            DiagnosticId: 'WHITESPACE',
            FormatDescription: 'Fix whitespace formatting. Insert \\n.',
          },
        ],
      },
    ]);

    expect(parseDotnetFormatReport(report, projectPath)).toEqual([
      expect.objectContaining({
        file: 'Program.cs',
        line: 1,
        column: 14,
        ruleId: 'WHITESPACE',
        severity: 'low',
        source: 'dotnetFormat',
        category: 'style',
      }),
    ]);
  });

  it('scopes findings to the selected Unity root', async () => {
    const { parseDotnetFormatReport } = await importAdapter();
    const projectPath = await makeTempDir('atlas-dotnet-format-unity-parse-');
    const report = JSON.stringify([
      {
        FileName: 'Player.cs',
        FilePath: path.join(projectPath, 'Project_BLACK', 'BLACK_Unity', 'Assets', 'Scripts', 'Player.cs'),
        FileChanges: [{ LineNumber: 2, CharNumber: 1, DiagnosticId: 'WHITESPACE', FormatDescription: 'Fix formatting.' }],
      },
      {
        FileName: 'Plugin.cs',
        FilePath: path.join(projectPath, 'Project_BLACK', 'BLACK_FMOD', 'Assets', 'Scripts', 'Plugin.cs'),
        FileChanges: [{ LineNumber: 4, CharNumber: 2, DiagnosticId: 'WHITESPACE', FormatDescription: 'Fix formatting.' }],
      },
    ]);

    expect(parseDotnetFormatReport(report, projectPath, {
      isUnity: true,
      unityRoot: 'Project_BLACK/BLACK_Unity',
    })).toEqual([
      expect.objectContaining({
        file: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Player.cs',
      }),
    ]);
  });

  it('runs dotnet format on the selected project and changed C# files only', async () => {
    const { run } = await importAdapter();
    const projectPath = await makeTempDir('atlas-dotnet-format-run-');
    await fs.mkdir(path.join(projectPath, 'Project_BLACK', 'BLACK_Unity', 'Assets', 'Scripts'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'Project_BLACK', 'BLACK_Unity', 'ProjectSettings'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'Project_BLACK', 'BLACK_Unity', 'Assembly-CSharp.csproj'), '<Project />\n', 'utf8');
    const changedFile = 'Project_BLACK/BLACK_Unity/Assets/Scripts/Player.cs';
    await fs.writeFile(path.join(projectPath, changedFile), 'class Player{}\n', 'utf8');

    execFileMock.mockImplementation((_binary, args, _options, callback) => {
      const reportDirIndex = args.indexOf('--report');
      const reportDir = reportDirIndex >= 0 ? args[reportDirIndex + 1] : null;
      if (reportDir) {
        writeFileSync(path.join(reportDir, 'format-report.json'), JSON.stringify([
          {
            FileName: 'Player.cs',
            FilePath: path.join(projectPath, changedFile),
            FileChanges: [
              {
                LineNumber: 1,
                CharNumber: 13,
                DiagnosticId: 'WHITESPACE',
                FormatDescription: 'Fix formatting.',
              },
            ],
          },
        ]), 'utf8');
      }
      callback(Object.assign(new Error('format violations present'), { code: 2 }), '', '');
      return { kill() {} };
    });

    const findings = await run(projectPath, [changedFile], {
      reviewProfile: createUnityReviewProfile('Project_BLACK/BLACK_Unity'),
    });

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining([
      'format',
      'Project_BLACK/BLACK_Unity/Assembly-CSharp.csproj',
      '--no-restore',
      '--verify-no-changes',
      '--include',
      changedFile,
    ]));
    expect(findings).toEqual([
      expect.objectContaining({
        file: changedFile,
        ruleId: 'WHITESPACE',
      }),
    ]);
  });
});
