import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateDiffFromFiles } from '../reviewDiff.js';
import { runUnitySemanticVerifier } from '../unitySemanticVerifier.js';

const reviewProfile = {
  id: 'unity_csharp',
  stackFamily: 'unity',
  projectContext: {
    unityRoot: 'Project_BLACK/BLACK_Unity',
  },
};

const tempRepos = [];

async function createTempUnityRepo(files = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-unity-verifier-'));
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

describe('runUnitySemanticVerifier', () => {
  it('detects missing unsubscribe in lifecycle methods', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/UI/RewardPopupPresenter.cs',
        before: `using UnityEngine;

public sealed class RewardPopupPresenter : MonoBehaviour
{
    private RewardModel _model;

    private void OnEnable()
    {
    }

    private void OnDisable()
    {
        _model.Changed -= HandleModelChanged;
    }

    private void HandleModelChanged()
    {
    }
}
`,
        after: `using UnityEngine;

public sealed class RewardPopupPresenter : MonoBehaviour
{
    private RewardModel _model;

    private void OnEnable()
    {
        _model.Changed += HandleModelChanged;
    }

    private void OnDisable()
    {
    }

    private void HandleModelChanged()
    {
    }
}
`,
      },
    ];

    const result = await runUnitySemanticVerifier('/repo', files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.anchoredFindings).toHaveLength(1);
    expect(result.anchoredFindings[0]).toMatchObject({
      ruleId: 'unity.missing_unsubscribe',
      severity: 'high',
      confidence: 'high',
      promotionMode: 'direct_finding',
    });
  });

  it('detects editor-only APIs in runtime files', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/RuntimeSaveLoader.cs',
        before: `using UnityEngine;

public sealed class RuntimeSaveLoader : MonoBehaviour
{
}
`,
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
      },
    ];

    const result = await runUnitySemanticVerifier('/repo', files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.anchoredFindings).toHaveLength(1);
    expect(result.anchoredFindings[0]).toMatchObject({
      ruleId: 'unity.editor_api_in_runtime_path',
      severity: 'high',
      confidence: 'high',
    });
  });

  it('detects multiple editor-only API uses in the same runtime file', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/RuntimeSaveLoader.cs',
        before: `using UnityEngine;

public sealed class RuntimeSaveLoader : MonoBehaviour
{
}
`,
        after: `using UnityEngine;

public sealed class RuntimeSaveLoader : MonoBehaviour
{
    private void Load()
    {
        UnityEditor.AssetDatabase.Refresh();
        UnityEditor.EditorUtility.SetDirty(this);
    }
}
`,
      },
    ];

    const result = await runUnitySemanticVerifier('/repo', files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.anchoredFindings).toHaveLength(2);
    expect(result.anchoredFindings.every((finding) => finding.ruleId === 'unity.editor_api_in_runtime_path')).toBe(true);
  });

  it('ignores editor-only APIs when they are fully gated by UNITY_EDITOR', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/BLACK/Door/Scripts/DoorPointsConfig.cs',
        before: `using UnityEngine;

public sealed class DoorPointsConfig : ScriptableObject
{
}
`,
        after: `using UnityEngine;

#if UNITY_EDITOR
using UnityEditor;
#endif

public sealed class DoorPointsConfig : ScriptableObject
{
#if UNITY_EDITOR
    public void Save()
    {
        AssetDatabase.SaveAssets();
    }
#endif
}
`,
      },
    ];

    const result = await runUnitySemanticVerifier('/repo', files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.anchoredFindings).toHaveLength(0);
  });

  it('handles #if/#elif/#else editor guards without marking the else branch as editor-only', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/RuntimeSaveLoader.cs',
        before: `using UnityEngine;

public sealed class RuntimeSaveLoader : MonoBehaviour
{
}
`,
        after: `using UnityEngine;

public sealed class RuntimeSaveLoader : MonoBehaviour
{
#if !UNITY_EDITOR
    public void LoadRuntime()
    {
    }
#elif UNITY_EDITOR
    public void SaveEditor()
    {
        UnityEditor.AssetDatabase.SaveAssets();
    }
#else
    public void PingEditor()
    {
        UnityEditor.EditorUtility.SetDirty(this);
    }
#endif
}
`,
      },
    ];

    const result = await runUnitySemanticVerifier('/repo', files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.anchoredFindings).toHaveLength(1);
    expect(result.anchoredFindings[0].ruleId).toBe('unity.editor_api_in_runtime_path');
    expect(result.anchoredFindings[0].line).toBeGreaterThan(10);
  });

  it('emits pooled state reset concerns as candidate evidence', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/UI/PooledRewardCell.cs',
        before: `using UnityEngine;
using UnityEngine.Pool;

public sealed class PooledRewardCell : MonoBehaviour
{
    private string _rewardId;

    public void OnTakeFromPool(string rewardId)
    {
    }

    public void OnReturnedToPool()
    {
        _rewardId = null;
    }
}
`,
        after: `using UnityEngine;
using UnityEngine.Pool;

public sealed class PooledRewardCell : MonoBehaviour
{
    private string _rewardId;

    public void OnTakeFromPool(string rewardId)
    {
        _rewardId = rewardId;
    }

    public void OnReturnedToPool()
    {
    }
}
`,
      },
    ];

    const result = await runUnitySemanticVerifier('/repo', files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.anchoredFindings).toHaveLength(1);
    expect(result.anchoredFindings[0]).toMatchObject({
      ruleId: 'unity.pooled_state_not_reset',
      severity: 'medium',
      confidence: 'medium',
      promotionMode: 'candidate_evidence',
    });
    expect(result.promptFindings).toHaveLength(1);
  });

  it('emits one pooled-state finding per unreset assigned field', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/UI/PooledRewardCell.cs',
        before: `using UnityEngine;
using UnityEngine.Pool;

public sealed class PooledRewardCell : MonoBehaviour
{
    private string _rewardId;
    private Sprite _icon;

    public void OnTakeFromPool(string rewardId, Sprite icon)
    {
    }

    public void OnReturnedToPool()
    {
    }
}
`,
        after: `using UnityEngine;
using UnityEngine.Pool;

public sealed class PooledRewardCell : MonoBehaviour
{
    private string _rewardId;
    private Sprite _icon;

    public void OnTakeFromPool(string rewardId, Sprite icon)
    {
        _rewardId = rewardId;
        _icon = icon;
    }

    public void OnReturnedToPool()
    {
    }
}
`,
      },
    ];

    const result = await runUnitySemanticVerifier('/repo', files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.anchoredFindings).toHaveLength(2);
    expect(result.anchoredFindings.every((finding) => finding.ruleId === 'unity.pooled_state_not_reset')).toBe(true);
  });

  it('suppresses editor API findings when local asmdef is editor-only', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/BLACK/Door/Scripts/DoorPointsConfig.cs',
        before: '',
        after: `using UnityEngine;
using UnityEditor;

public sealed class DoorPointsConfig : ScriptableObject
{
    public void Save()
    {
        AssetDatabase.SaveAssets();
    }
}
`,
      },
    ];
    const repoRoot = await createTempUnityRepo({
      'Project_BLACK/BLACK_Unity/Assets/BLACK/Door/Scripts/Door.Editor.asmdef': JSON.stringify({
        name: 'Door.Editor',
        includePlatforms: ['Editor'],
      }, null, 2),
    });

    const result = await runUnitySemanticVerifier(repoRoot, files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.findings).toHaveLength(0);
    expect(result.anchoredFindings).toHaveLength(0);
    expect(result.stats.toolsAttempted).toContain('review_local_codebase_verifier');
    expect(result.stats.toolsSucceeded).toContain('review_local_codebase_verifier');
    expect(result.localVerification).toMatchObject({ providerId: 'unity' });
  });

  it('suppresses support-only lifecycle findings after local verification', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Tests/Runtime/RewardPopupPresenter.cs',
        before: `using UnityEngine;

public sealed class RewardPopupPresenter : MonoBehaviour
{
    private RewardModel _model;

    private void OnEnable()
    {
    }

    private void OnDisable()
    {
    }

    private void HandleModelChanged()
    {
    }
}
`,
        after: `using UnityEngine;

public sealed class RewardPopupPresenter : MonoBehaviour
{
    private RewardModel _model;

    private void OnEnable()
    {
        _model.Changed += HandleModelChanged;
    }

    private void OnDisable()
    {
    }

    private void HandleModelChanged()
    {
    }
}
`,
      },
    ];
    const repoRoot = await createTempUnityRepo();

    const result = await runUnitySemanticVerifier(repoRoot, files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.findings).toHaveLength(0);
    expect(result.anchoredFindings).toHaveLength(0);
    expect(result.stats.toolsSucceeded).toContain('review_local_codebase_verifier');
  });

  it('adds compact local evidence to surviving runtime findings', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/RuntimeSaveLoader.cs',
        before: `using UnityEngine;

public sealed class RuntimeSaveLoader : MonoBehaviour
{
}
`,
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
      },
    ];
    const repoRoot = await createTempUnityRepo({
      'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/Gameplay.Runtime.asmdef': JSON.stringify({
        name: 'Gameplay.Runtime',
        references: [],
      }, null, 2),
      'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/RuntimeSaveLoaderBootstrap.cs': `public sealed class RuntimeSaveLoaderBootstrap
{
    private RuntimeSaveLoader _loader;
}
`,
    });

    const result = await runUnitySemanticVerifier(repoRoot, files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.anchoredFindings).toHaveLength(1);
    expect(result.anchoredFindings[0]).toMatchObject({
      ruleId: 'unity.editor_api_in_runtime_path',
      productionPath: true,
    });
    expect(result.anchoredFindings[0].evidenceSummary).toContain('runtime-capable asmdef');
    expect(result.anchoredFindings[0].evidenceSummary).toContain('nearby runtime reference');
    expect(result.anchoredFindings[0].promptEvidenceSummary).toBe('runtime path, runtime asmdef, 1 runtime ref');
    expect(result.anchoredFindings[0].supportingFiles).toContain('Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/Gameplay.Runtime.asmdef');
    expect(result.stats.toolsSucceeded).toContain('review_local_codebase_verifier');
  });

  it('promotes runtime service binding evidence for editor API leaks', async () => {
    const files = [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/BLACK/Settings/Scripts/GameSettingsService.cs',
        before: '',
        after: `using Lila.Core.App;
using UnityEditor;

[ServiceBinding(typeof(IGameSettingsService), new string[] { }, new[] { ServiceBindingConstants.HeadlessCondition })]
public class GameSettingsService : IGameSettingsService
{
    public void Save()
    {
        AssetDatabase.SaveAssets();
    }
}
`,
      },
    ];
    const repoRoot = await createTempUnityRepo({
      'Project_BLACK/BLACK_Unity/Assets/BLACK/Settings/Scripts/GraphicSettingsMediator.cs': `public sealed class GraphicSettingsMediator
{
    private GameSettingsService _service;
}
`,
    });

    const result = await runUnitySemanticVerifier(repoRoot, files, generateDiffFromFiles(files), {
      reviewProfile,
      unitySemanticVerifier: { enabled: true },
    });

    expect(result.anchoredFindings).toHaveLength(1);
    expect(result.anchoredFindings[0].message).toContain('Runtime service binding references UnityEditor APIs');
    expect(result.anchoredFindings[0].evidenceSummary).toContain('runtime service binding');
    expect(result.anchoredFindings[0].promptEvidenceSummary).toBe('runtime service, 1 runtime ref');
  });
});
