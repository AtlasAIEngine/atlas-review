import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { runReviewLocalCodebaseVerification } from '../localCodebaseVerification.js';

const tempRepos = [];

async function createTempRepo(files = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-local-verification-'));
  tempRepos.push(tempDir);
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const absPath = path.join(tempDir, relativePath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content, 'utf8');
    })
  );
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempRepos.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('runReviewLocalCodebaseVerification', () => {
  it('skips unsupported stacks', async () => {
    const result = await runReviewLocalCodebaseVerification('/repo', [], {
      reviewProfile: { stackFamily: 'nextjs' },
    });

    expect(result.stats).toMatchObject({
      enabled: false,
      skippedReason: 'unsupported_stack:nextjs',
      providerId: null,
    });
  });

  it('routes Unity findings through the shared local verification seam', async () => {
    const repoRoot = await createTempRepo({
      'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/Gameplay.Runtime.asmdef': JSON.stringify({
        name: 'Gameplay.Runtime',
      }, null, 2),
      'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/RuntimeSaveLoaderBootstrap.cs': `public sealed class RuntimeSaveLoaderBootstrap
{
    private RuntimeSaveLoader _loader;
}
`,
    });

    const result = await runReviewLocalCodebaseVerification(repoRoot, [{
      file: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/RuntimeSaveLoader.cs',
      line: 2,
      severity: 'high',
      ruleId: 'unity.editor_api_in_runtime_path',
      message: 'Runtime code references UnityEditor APIs, which will break player builds or runtime execution.',
      confidence: 'high',
      source: 'unity-semantic',
    }], {
      reviewProfile: {
        stackFamily: 'unity',
        projectContext: { unityRoot: 'Project_BLACK/BLACK_Unity' },
      },
      reviewFiles: [{
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/RuntimeSaveLoader.cs',
        after: `using UnityEngine;
using UnityEditor;

public sealed class RuntimeSaveLoader : MonoBehaviour
{
    private void Load()
    {
        AssetDatabase.Refresh();
    }
}
`,
      }],
    });

    expect(result.providerId).toBe('unity');
    expect(result.stats.bundleEntryCount).toBe(1);
    expect(result.findings[0]).toMatchObject({
      productionPath: true,
      promptEvidenceSummary: 'runtime path, runtime asmdef, 1 runtime ref',
    });
  });
});
