import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  DEFAULT_REVIEW_PROFILE_ID,
  resolveReviewProjectProfile,
} from '../reviewProjectProfileService.js';

describe('reviewProjectProfileService', () => {
  it('returns the generic fallback profile when no preset or markers match', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-profile-generic-'));
    try {
      const profile = await resolveReviewProjectProfile({
        projectPath,
        explicitPresetId: null,
        presetLoader: async () => null,
      });

      expect(profile.id).toBe(DEFAULT_REVIEW_PROFILE_ID);
      expect(profile.source).toBe('fallback');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('prefers the explicit unity preset even when project markers are absent', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-profile-preset-'));
    try {
      const profile = await resolveReviewProjectProfile({
        projectPath,
        explicitPresetId: 'unity_csharp',
      });

      expect(profile.id).toBe('unity_csharp');
      expect(profile.source).toBe('preset');
      expect(profile.presetId).toBe('unity_csharp');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('detects the unity profile from repository markers', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-profile-unity-'));
    try {
      await fs.mkdir(path.join(projectPath, 'ProjectSettings'), { recursive: true });
      await fs.mkdir(path.join(projectPath, 'Assets'), { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'),
        'm_EditorVersion: 6000.0.20f1\n',
        'utf8'
      );

      const profile = await resolveReviewProjectProfile({
        projectPath,
        explicitPresetId: null,
        presetLoader: async () => null,
      });

      expect(profile.id).toBe('unity_csharp');
      expect(profile.source).toBe('detected');
      expect(profile.detectionSignals).toContain('ProjectSettings/ProjectVersion.txt');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('detects nested Unity roots generically from marker rules', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-profile-unity-nested-'));
    try {
      const unityRoot = path.join(projectPath, 'Project_BLACK', 'BLACK_Unity');
      await fs.mkdir(path.join(unityRoot, 'ProjectSettings'), { recursive: true });
      await fs.mkdir(path.join(unityRoot, 'Assets'), { recursive: true });
      await fs.writeFile(
        path.join(unityRoot, 'ProjectSettings', 'ProjectVersion.txt'),
        'm_EditorVersion: 6000.0.20f1\n',
        'utf8'
      );

      const profile = await resolveReviewProjectProfile({
        projectPath,
        explicitPresetId: null,
        presetLoader: async () => null,
      });

      expect(profile.id).toBe('unity_csharp');
      expect(profile.source).toBe('detected');
      expect(profile.detectionSignals).toContain('Project_BLACK/BLACK_Unity/ProjectSettings/ProjectVersion.txt');
      expect(profile.detectionSignals).toContain('Project_BLACK/BLACK_Unity/Assets');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('selects a single primary Unity root deterministically and skips sibling Unity-like trees', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-profile-unity-primary-'));
    try {
      const unityRoot = path.join(projectPath, 'Project_BLACK', 'BLACK_Unity');
      const fmodRoot = path.join(projectPath, 'Project_BLACK', 'BLACK_FMOD');

      await fs.mkdir(path.join(unityRoot, 'ProjectSettings'), { recursive: true });
      await fs.mkdir(path.join(unityRoot, 'Assets', 'Scripts'), { recursive: true });
      await fs.mkdir(path.join(unityRoot, 'Packages'), { recursive: true });
      await fs.writeFile(path.join(unityRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.20f1\n', 'utf8');
      await fs.writeFile(path.join(unityRoot, 'Packages', 'manifest.json'), '{}\n', 'utf8');

      await fs.mkdir(path.join(fmodRoot, 'ProjectSettings'), { recursive: true });
      await fs.mkdir(path.join(fmodRoot, 'Assets'), { recursive: true });
      await fs.writeFile(path.join(fmodRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.20f1\n', 'utf8');

      const profile = await resolveReviewProjectProfile({
        projectPath,
        explicitPresetId: null,
        presetLoader: async () => null,
      });

      expect(profile.id).toBe('unity_csharp');
      expect(profile.source).toBe('detected');
      expect(profile.projectContext).toEqual(expect.objectContaining({
        unityRoot: 'Project_BLACK/BLACK_Unity',
      }));
      expect(profile.detectionSignals).toContain('Project_BLACK/BLACK_Unity/Packages/manifest.json');
      expect(profile.classifyEntry({ path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Game.cs' }).fileClass).toBe('deep');
      expect(profile.classifyEntry({ path: 'Project_BLACK/BLACK_FMOD/Assets/FmodBridge.cs' }).fileClass).toBe('skip');
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });
});
