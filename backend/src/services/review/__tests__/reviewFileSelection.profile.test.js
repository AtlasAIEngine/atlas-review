import { describe, it, expect } from 'vitest';

import { shapeReviewScopeForProfile } from '../reviewFileSelection.js';
import { getReviewProfileById } from '../reviewProjectProfileService.js';

describe('shapeReviewScopeForProfile', () => {
  it('pairs Unity assets with sibling meta files into one logical review unit', () => {
    const profile = getReviewProfileById('unity_csharp');
    const entries = [
      { path: 'Assets/Scripts/PlayerController.cs', status: 'M', reviewSizeHint: 1800 },
      { path: 'Assets/Prefabs/Player.prefab', status: 'M', reviewSizeHint: 2200 },
      { path: 'Assets/Prefabs/Player.prefab.meta', status: 'M', reviewSizeHint: 300 },
    ];

    const shaped = shapeReviewScopeForProfile(entries, { reviewProfile: profile });

    expect(shaped.reviewUnits).toHaveLength(2);
    expect(shaped.reviewUnits.map((entry) => entry.path)).toEqual([
      'Assets/Scripts/PlayerController.cs',
      'Assets/Prefabs/Player.prefab',
    ]);
    expect(shaped.reviewUnits[1].memberPaths).toEqual([
      'Assets/Prefabs/Player.prefab',
      'Assets/Prefabs/Player.prefab.meta',
    ]);
    expect(shaped.telemetry.pairedFiles).toBe(1);
    expect(shaped.telemetry.rawFileCount).toBe(3);
    expect(shaped.telemetry.reviewUnitCount).toBe(2);
  });

  it('collapses low-signal Unity asset churn out of the deep-review unit count', () => {
    const profile = getReviewProfileById('unity_csharp');
    const entries = [
      { path: 'Assets/Art/Props/DataDonate.mat', status: 'A', reviewSizeHint: 600 },
      { path: 'Assets/Art/Props/DataDonate.mat.meta', status: 'A', reviewSizeHint: 120 },
      { path: 'Assets/Art/Props/HUD.meta', status: 'A', reviewSizeHint: 90 },
      { path: 'Assets/Scripts/DonateFlow.cs', status: 'M', reviewSizeHint: 2000 },
    ];

    const shaped = shapeReviewScopeForProfile(entries, { reviewProfile: profile });

    expect(shaped.reviewUnits).toHaveLength(1);
    expect(shaped.reviewUnits[0].path).toBe('Assets/Scripts/DonateFlow.cs');
    expect(shaped.telemetry.classCounts.deep).toBe(1);
    expect(shaped.telemetry.classCounts.collapsed).toBe(3);
    expect(shaped.telemetry.reviewUnitCount).toBe(1);
  });
});
