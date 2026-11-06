import { test, expect } from '@playwright/test';

import {
  buildReviewFileTree,
  classifyReviewFilePath,
  flattenReviewFileTreeEntriesByFolder,
  getReviewFileTreeVisibleState,
} from '../review/reviewPanelUtils';

test.describe('review panel file tree', () => {
  test('builds risky, code-only, and generic review buckets from mixed project files', () => {
    const tree = buildReviewFileTree({
      files: [
        { path: 'Assets/Scripts/BotLoot.cs', status: 'M', additions: 11, deletions: 1, oldPath: null },
        { path: 'Assets/Tests/PathDistanceTest.cs', status: 'M', additions: 58, deletions: 9, oldPath: null },
        { path: 'Assets/AI/EQSTestConfig.cs', status: 'M', additions: 105, deletions: 12, oldPath: null },
        { path: 'Assets/Tests/PathDistanceTest.cs.meta', status: 'M', additions: 1, deletions: 0, oldPath: null },
        { path: 'Assets/Scenes/Level01.unity', status: 'M', additions: 17, deletions: 3, oldPath: null },
        { path: 'Assets/NavMesh/Level01NavMesh.asset', status: 'M', additions: 9, deletions: 1, oldPath: null },
        { path: 'Assets/NavMesh/AmbroseValley.pathmapasset', status: 'A', additions: 3, deletions: 0, oldPath: null },
        { path: 'Assets/Prefabs/Enemy.prefab', status: 'M', additions: 4, deletions: 1, oldPath: null },
        { path: 'Assets/Materials/Enemy.mat', status: 'M', additions: 3, deletions: 1, oldPath: null },
        { path: 'Assets/Plugins/lib-ai-navigation.dll', status: 'M', additions: 2, deletions: 2, oldPath: null },
        { path: '.gitattributes', status: 'M', additions: 1, deletions: 0, oldPath: null },
        { path: 'docs/ai/RuleBasedAI_Setup_Guide.md', status: 'A', additions: 601, deletions: 0, oldPath: null },
        { path: 'Cargo.lock', status: 'M', additions: 12, deletions: 4, oldPath: null },
        { path: 'dist/app.min.js', status: 'M', additions: 90, deletions: 60, oldPath: null },
      ],
      review: {
        riskLevel: 'medium',
        summary: 'Unity-heavy PR',
        reviewedAt: '2026-03-12T10:00:00.000Z',
        changeGroups: [
          {
            label: 'Gameplay systems',
            description: 'Code changes',
            risk: 'medium',
            files: [
              { path: 'Assets/Scripts/BotLoot.cs', additions: 11, deletions: 1, description: 'Bot loot changes' },
            ],
          },
        ],
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Guard path cache invalidation',
            description: 'Cache misses can cascade under load',
            file: 'Assets/Tests/PathDistanceTest.cs',
            line: 42,
          },
          {
            type: 'issue',
            severity: 'medium',
            title: 'Handle empty nav target',
            description: 'Missing null guard in test fixture',
            file: 'Assets/Tests/PathDistanceTest.cs',
            line: 58,
          },
          {
            type: 'issue',
            severity: 'medium',
            title: 'Avoid mutating shared config',
            description: 'State leaks between scenarios',
            file: 'Assets/AI/EQSTestConfig.cs',
            line: 17,
          },
        ],
        stats: {},
      } as any,
    });

    expect(tree.totalCount).toBe(14);
    expect(tree.filters.all.count).toBe(14);
    expect(tree.filters.risky.count).toBe(2);
    expect(tree.filters.code_only.count).toBe(3);
    expect(tree.standaloneEntries.map((entry) => entry.path)).toEqual([
      'Assets/Tests/PathDistanceTest.cs',
      'Assets/AI/EQSTestConfig.cs',
      'Assets/Scripts/BotLoot.cs',
    ]);
    expect(tree.buckets.map((bucket) => `${bucket.label}:${bucket.entries.length}`)).toEqual([
      'Config:1',
      'Docs & Planning:1',
      'Metadata:1',
      'Assets & Media:3',
      'Generated / Data:4',
      'Binary / Artifacts:1',
    ]);
  });

  test('filters visible files for code-only selections without pulling Unity noise back in', () => {
    const tree = buildReviewFileTree({
      files: [
        { path: 'Assets/Scripts/BotLoot.cs', status: 'M', additions: 11, deletions: 1, oldPath: null },
        { path: 'Assets/Tests/PathDistanceTest.cs', status: 'M', additions: 58, deletions: 9, oldPath: null },
        { path: 'Assets/Tests/PathDistanceTest.cs.meta', status: 'M', additions: 1, deletions: 0, oldPath: null },
        { path: 'Assets/Scenes/Level01.unity', status: 'M', additions: 17, deletions: 3, oldPath: null },
      ],
      review: {
        riskLevel: 'medium',
        summary: 'Unity-heavy PR',
        reviewedAt: '2026-03-12T10:00:00.000Z',
        changeGroups: [],
        recommendations: [],
        stats: {},
      } as any,
    });

    const visible = getReviewFileTreeVisibleState({
      tree,
      activePaths: tree.filters.code_only.paths,
    });

    expect(visible.totalVisibleCount).toBe(2);
    expect(visible.standaloneEntries.map((entry) => entry.path)).toEqual([
      'Assets/Scripts/BotLoot.cs',
      'Assets/Tests/PathDistanceTest.cs',
    ]);
    expect(visible.buckets).toHaveLength(0);
  });

  test('flattens folder-grouped files in the same folders-first order as the file tree', () => {
    const entries = [
      { path: 'dir/sub/inner.ts', status: 'M', additions: 1, deletions: 0, oldPath: null },
      { path: 'pkg-a.json', status: 'M', additions: 1, deletions: 0, oldPath: null },
      { path: 'dir/file.ts', status: 'M', additions: 1, deletions: 0, oldPath: null },
      { path: 'dir/sub/next.ts', status: 'M', additions: 1, deletions: 0, oldPath: null },
      { path: 'dir/other/deep.ts', status: 'M', additions: 1, deletions: 0, oldPath: null },
    ] as any[];

    expect(flattenReviewFileTreeEntriesByFolder(entries).map((entry) => entry.path)).toEqual([
      'dir/sub/inner.ts',
      'dir/sub/next.ts',
      'dir/other/deep.ts',
      'dir/file.ts',
      'pkg-a.json',
    ]);
  });

  test('classifies generic review buckets deterministically', () => {
    expect(classifyReviewFilePath('Assets/Player/Player.cs')).toMatchObject({
      fileClass: 'code',
      bucketId: null,
      isCode: true,
    });
    expect(classifyReviewFilePath('Assets/Scenes/BossArena.unity')).toMatchObject({
      fileClass: 'asset_media',
      bucketId: 'assets_media',
      isCode: false,
    });
    expect(classifyReviewFilePath('Assets/NavMesh/AmbroseValley.pathmapasset')).toMatchObject({
      fileClass: 'generated',
      bucketId: 'generated_data',
      isCode: false,
    });
    expect(classifyReviewFilePath('Assets/NavMesh/WorldNavMesh.asset')).toMatchObject({
      fileClass: 'generated',
      bucketId: 'generated_data',
      isCode: false,
    });
    expect(classifyReviewFilePath('Assets/Level Design/GranadiRit/GranadiRit/Lightmap-0_comp_light.exr')).toMatchObject({
      fileClass: 'generated',
      bucketId: 'baked_lighting',
      isCode: false,
    });
    expect(classifyReviewFilePath('Assets/Level Design/GranadiRit/GranadiRit/LightingData.asset')).toMatchObject({
      fileClass: 'generated',
      bucketId: 'baked_lighting',
      isCode: false,
    });
    expect(classifyReviewFilePath('Assets/Enemies/Enemy.prefab')).toMatchObject({
      fileClass: 'asset_media',
      bucketId: 'assets_media',
      isCode: false,
    });
    expect(classifyReviewFilePath('Assets/Enemies/Enemy.prefab.meta')).toMatchObject({
      fileClass: 'metadata',
      bucketId: 'metadata_files',
      isCode: false,
    });
    expect(classifyReviewFilePath('.gitattributes')).toMatchObject({
      fileClass: 'config',
      bucketId: 'config_files',
      isCode: false,
    });
    expect(classifyReviewFilePath('.codex/config.toml')).toMatchObject({
      fileClass: 'config',
      bucketId: 'config_files',
      isCode: false,
    });
    expect(classifyReviewFilePath('.nakamaconfig.yml')).toMatchObject({
      fileClass: 'config',
      bucketId: 'config_files',
      isCode: false,
    });
    expect(classifyReviewFilePath('api/openapi.yaml')).toMatchObject({
      fileClass: 'config',
      bucketId: 'config_files',
      isCode: false,
    });
    expect(classifyReviewFilePath('docs/ai/RuleBasedAI_Setup_Guide.md')).toMatchObject({
      fileClass: 'documentation',
      bucketId: 'documentation',
      isCode: false,
    });
    expect(classifyReviewFilePath('.planning/archive/MILESTONES.md')).toMatchObject({
      fileClass: 'documentation',
      bucketId: 'documentation',
      isCode: false,
    });
    expect(classifyReviewFilePath('Assets/Plugins/lib-ai-navigation.dll')).toMatchObject({
      fileClass: 'binary_artifact',
      bucketId: 'binary_artifacts',
      isCode: false,
    });
    expect(classifyReviewFilePath('Cargo.lock')).toMatchObject({
      fileClass: 'generated',
      bucketId: 'generated_data',
      isCode: false,
    });
    expect(classifyReviewFilePath('dist/app.min.js')).toMatchObject({
      fileClass: 'generated',
      bucketId: 'generated_data',
      isCode: false,
    });
  });

  test('groups Unity baked lighting artifacts into a collapsed bucket', () => {
    const tree = buildReviewFileTree({
      files: [
        { path: 'Assets/Scripts/BotLoot.cs', status: 'M', additions: 11, deletions: 1, oldPath: null },
        { path: 'Assets/Level Design/GranadiRit/GranadiRit/LightingData.asset', status: 'M', additions: 3, deletions: 1, oldPath: null },
        { path: 'Assets/Level Design/GranadiRit/GranadiRit/Lightmap-0_comp_light.exr', status: 'M', additions: 2, deletions: 2, oldPath: null },
        { path: 'Assets/Level Design/GranadiRit/GranadiRit/Lightmap-1_comp_light.exr', status: 'A', additions: 3, deletions: 0, oldPath: null },
      ],
      review: {
        riskLevel: 'low',
        summary: 'Scene bake refresh',
        reviewedAt: '2026-04-03T10:00:00.000Z',
        changeGroups: [],
        recommendations: [],
        stats: {},
      } as any,
    });

    expect(tree.standaloneEntries.map((entry) => entry.path)).toEqual([
      'Assets/Scripts/BotLoot.cs',
    ]);
    expect(tree.buckets.map((bucket) => `${bucket.label}:${bucket.entries.length}`)).toEqual([
      'Baked Lighting:3',
    ]);
  });

  test('keeps authored LightingData and lightmap-named textures out of baked lighting buckets', () => {
    expect(classifyReviewFilePath('Assets/Data/LightingData.asset')).toMatchObject({
      fileClass: 'asset_media',
      bucketId: 'assets_media',
      isCode: false,
    });

    expect(classifyReviewFilePath('Assets/UI/Lightmap-Button.png')).toMatchObject({
      fileClass: 'asset_media',
      bucketId: 'assets_media',
      isCode: false,
    });

    expect(classifyReviewFilePath('Assets/Levels/Arena/Lighting/LightingData.asset')).toMatchObject({
      fileClass: 'generated',
      bucketId: 'baked_lighting',
      isCode: false,
    });

    expect(classifyReviewFilePath('Assets/Levels/Arena/Lightmaps/Lightmap-0_comp_light.png')).toMatchObject({
      fileClass: 'generated',
      bucketId: 'baked_lighting',
      isCode: false,
    });
  });
});
