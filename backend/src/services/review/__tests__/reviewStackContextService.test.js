import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { collectReviewStackContext } from '../reviewStackContextService.js';
import { resolveReviewProjectProfile } from '../reviewProjectProfileService.js';

describe('reviewStackContextService', () => {
  it('builds historical learning blocks from recurring cached findings', async () => {
    const result = await collectReviewStackContext('/tmp/project', {
      contextFiles: [
        { path: 'Assets/Scripts/LoginFlow.cs' },
      ],
      priorCacheRows: [
        {
          filePath: 'Assets/Scripts/LoginFlow.cs',
          updatedAt: '2026-04-09T10:00:00.000Z',
          review: {
            recommendations: [
              {
                type: 'issue',
                severity: 'high',
                title: 'Missing unsubscribe in OnDisable',
              },
            ],
          },
        },
        {
          filePath: 'Assets/Scripts/LoginFlow.cs',
          updatedAt: '2026-04-09T11:00:00.000Z',
          review: {
            recommendations: [
              {
                type: 'issue',
                severity: 'medium',
                title: 'Missing unsubscribe in OnDisable',
              },
            ],
          },
        },
      ],
      projectMetadata: {
        projectType: 'unity',
        configFile: 'ProjectSettings/ProjectVersion.txt',
        availableChecks: { lint: false, unit: false, e2e: false },
      },
    });

    expect(result.additionalBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'historical_review_learnings',
      }),
    ]));
    expect(result.additionalBlocks[0].lines.join('\n')).toContain('Missing unsubscribe in OnDisable');
    expect(result.additionalBlocks[0].lines.join('\n')).toContain('x2');
  });

  it('collects Unity stack signals from the detected Unity root', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-stack-unity-'));
    try {
      const unityRoot = path.join(projectPath, 'GameProject');
      await fs.mkdir(path.join(unityRoot, 'ProjectSettings'), { recursive: true });
      await fs.mkdir(path.join(unityRoot, 'Packages'), { recursive: true });
      await fs.mkdir(path.join(unityRoot, 'Assets', 'Scripts'), { recursive: true });
      await fs.writeFile(
        path.join(unityRoot, 'ProjectSettings', 'ProjectVersion.txt'),
        'm_EditorVersion: 6000.0.20f1\n',
        'utf8'
      );
      await fs.writeFile(
        path.join(unityRoot, 'Packages', 'manifest.json'),
        JSON.stringify({
          dependencies: {
            'com.unity.addressables': '1.0.0',
            'com.unity.inputsystem': '1.0.0',
          },
        }),
        'utf8'
      );

      const reviewProfile = await resolveReviewProjectProfile({
        projectPath,
        explicitPresetId: null,
        presetLoader: async () => null,
      });

      const result = await collectReviewStackContext(projectPath, {
        reviewProfile,
        contextFiles: [
          { path: 'GameProject/Assets/Scripts/LoginFlow.cs' },
          { path: 'GameProject/Assets/Prefabs/LoginScreen.prefab' },
          { path: 'GameProject/Packages/manifest.json' },
        ],
        priorCacheRows: [],
        projectMetadata: {
          projectType: 'node',
          configFile: 'package.json',
          availableChecks: { lint: true, unit: false, e2e: false },
        },
      });

      expect(result.projectMetadata).toEqual(expect.objectContaining({
        projectType: 'unity',
        configFile: 'GameProject/ProjectSettings/ProjectVersion.txt',
      }));
      expect(result.additionalBlocks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'unity_stack_signals',
        }),
        expect.objectContaining({
          id: 'unity_review_focus',
        }),
      ]));
      const joined = result.additionalBlocks.map((block) => block.lines.join('\n')).join('\n');
      expect(joined).toContain('Unity editor version: 6000.0.20f1');
      expect(joined).toContain('com.unity.addressables');
      expect(joined).toContain('serialized reference stability');
      expect(joined).toContain('editor, package, and build-pipeline compatibility');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
