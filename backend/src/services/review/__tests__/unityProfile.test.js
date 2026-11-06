import { describe, expect, it } from 'vitest';

import { UNITY_REVIEW_PROFILE } from '../profiles/unityProfile.js';

const unityRoot = 'Project_BLACK/BLACK_Unity';

function classify(path, allPaths) {
  return UNITY_REVIEW_PROFILE.classifyEntry(
    { path },
    {
      allPaths: new Set(allPaths),
      projectContext: { unityRoot },
    }
  );
}

describe('UNITY_REVIEW_PROFILE', () => {
  it('collapses prefab churn when no risky invariant is present', () => {
    const prefabPath = `${unityRoot}/Assets/Prefabs/RewardPopup.prefab`;

    const result = classify(prefabPath, [
      prefabPath,
      `${prefabPath}.meta`,
    ]);

    expect(result.fileClass).toBe('collapsed');
    expect(result.reason).toBe('unity_scene_or_prefab_churn_without_risky_invariant');
  });

  it('keeps prefab churn structural when a code invariant is present', () => {
    const prefabPath = `${unityRoot}/Assets/Prefabs/RewardPopup.prefab`;
    const scriptPath = `${unityRoot}/Assets/Scripts/UI/RewardPopupPresenter.cs`;

    const result = classify(prefabPath, [
      prefabPath,
      scriptPath,
    ]);

    expect(result.fileClass).toBe('structural');
    expect(result.reason).toBe('unity_scene_or_prefab_with_risky_invariant');
  });

  it('collapses meta files when their sibling prefab is low-signal churn', () => {
    const prefabPath = `${unityRoot}/Assets/Prefabs/RewardPopup.prefab`;
    const metaPath = `${prefabPath}.meta`;

    const result = classify(metaPath, [
      prefabPath,
      metaPath,
    ]);

    expect(result.fileClass).toBe('collapsed');
    expect(result.reason).toBe('meta_for_low_signal_asset');
  });

  it('collapses user settings and generated project files', () => {
    expect(classify(`${unityRoot}/UserSettings/EditorUserSettings.asset`, [
      `${unityRoot}/UserSettings/EditorUserSettings.asset`,
    ])).toMatchObject({
      fileClass: 'collapsed',
      reason: 'unity_editor_or_artifact_noise',
    });

    expect(classify(`${unityRoot}/BLACK_Unity.sln`, [
      `${unityRoot}/BLACK_Unity.sln`,
    ])).toMatchObject({
      fileClass: 'collapsed',
      reason: 'unity_low_signal_asset',
    });
  });
});
