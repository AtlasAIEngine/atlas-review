import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateProjectGeneratedReviewPolicyMock = vi.fn();

vi.mock('../../../db/queries.js', () => ({
  updateProjectGeneratedReviewPolicy: (...args) => updateProjectGeneratedReviewPolicyMock(...args),
}));

import {
  applyReviewPolicyToReviewProfile,
  createGeneratedProjectReviewPolicyBaseline,
  createDefaultReviewPolicyDocument,
  ensureGeneratedProjectReviewPolicy,
  mergeReviewPolicyLayers,
  parseStoredGeneratedProjectReviewPolicy,
  resolveEffectiveReviewPolicy,
} from '../reviewPolicyService.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd, ...args) {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('reviewPolicyService', () => {
  let rootDir;
  let repoDir;

  beforeEach(async () => {
    updateProjectGeneratedReviewPolicyMock.mockReset();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-policy-'));
    repoDir = path.join(rootDir, 'repo');
    await fs.mkdir(path.join(repoDir, '.atlas'), { recursive: true });
    await runGit(rootDir, 'init', repoDir);
    await runGit(repoDir, 'config', 'user.name', 'Atlas Test');
    await runGit(repoDir, 'config', 'user.email', 'atlas-test@example.com');
    await runGit(repoDir, 'checkout', '-b', 'main');
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('loads repo policy from the trusted base branch instead of the feature head', async () => {
    await fs.writeFile(
      path.join(repoDir, '.atlas', 'review-policy.json'),
      JSON.stringify({
        version: 1,
        promptAppend: ['Trusted main guidance.'],
        paths: [
          {
            glob: 'Assets/**/*.prefab',
            fileClass: 'structural',
          },
        ],
      }, null, 2),
      'utf8'
    );
    await runGit(repoDir, 'add', '.');
    await runGit(repoDir, 'commit', '-m', 'chore: add trusted review policy');

    await runGit(repoDir, 'checkout', '-b', 'feature/policy-test');
    await fs.writeFile(
      path.join(repoDir, '.atlas', 'review-policy.json'),
      JSON.stringify({
        version: 1,
        promptAppend: ['Malicious feature guidance.'],
      }, null, 2),
      'utf8'
    );
    await runGit(repoDir, 'add', '.');
    await runGit(repoDir, 'commit', '-m', 'feat: attempt malicious policy override');

    const effectivePolicy = await resolveEffectiveReviewPolicy({
      projectPath: repoDir,
      reviewType: 'branch_review',
      reviewProfile: {
        id: 'generic',
        promptGuidance: 'Profile guidance.',
      },
      baseBranch: 'main',
    });

    expect(effectivePolicy.promptAppend).toContain('Profile guidance.');
    expect(effectivePolicy.promptAppend).toContain('Trusted main guidance.');
    expect(effectivePolicy.promptAppend).not.toContain('Malicious feature guidance.');
    expect(effectivePolicy.provenance.sourcePath).toBe('.atlas/review-policy.json');
    expect(effectivePolicy.provenance.trustedRef).toContain('main');

    const reviewProfile = applyReviewPolicyToReviewProfile({
      id: 'generic',
      classifyEntry() {
        return {
          fileClass: 'deep',
          reason: 'default',
          pairWithSiblingMeta: false,
          riskBoost: 0,
          sizeMultiplier: 1,
        };
      },
    }, effectivePolicy);

    expect(reviewProfile.classifyEntry({ path: 'Assets/Prefabs/HUD.prefab' }).fileClass).toBe('structural');
    expect(reviewProfile.classifyEntry({ path: 'src/app.js' }).fileClass).toBe('deep');
  });

  it('uses the PR base sha as the trusted policy ref when provided', async () => {
    await fs.writeFile(
      path.join(repoDir, '.atlas', 'review-policy.json'),
      JSON.stringify({
        version: 1,
        promptAppend: ['PR base guidance.'],
      }, null, 2),
      'utf8'
    );
    await runGit(repoDir, 'add', '.');
    await runGit(repoDir, 'commit', '-m', 'chore: add base policy');
    const baseSha = await gitOutput(repoDir, 'rev-parse', 'HEAD');

    await runGit(repoDir, 'checkout', '-b', 'feature/pr-policy-test');
    await fs.writeFile(path.join(repoDir, 'feature.js'), 'export const feature = true;\n', 'utf8');
    await runGit(repoDir, 'add', '.');
    await runGit(repoDir, 'commit', '-m', 'feat: branch change');

    const effectivePolicy = await resolveEffectiveReviewPolicy({
      projectPath: repoDir,
      reviewType: 'pr_review',
      reviewProfile: null,
      baseSha,
    });

    expect(effectivePolicy.provenance.trustedRef).toBe(baseSha);
    expect(effectivePolicy.provenance.trustedRefSource).toBe('pr_base_sha');
    expect(effectivePolicy.promptAppend).toContain('PR base guidance.');
  });

  it('falls back safely when the trusted policy file is invalid', async () => {
    await fs.writeFile(path.join(repoDir, '.atlas', 'review-policy.json'), '{ invalid json', 'utf8');
    await runGit(repoDir, 'add', '.');
    await runGit(repoDir, 'commit', '-m', 'chore: add invalid review policy');

    const effectivePolicy = await resolveEffectiveReviewPolicy({
      projectPath: repoDir,
      reviewType: 'branch_review',
      reviewProfile: null,
      baseBranch: 'main',
    });

    expect(effectivePolicy.provenance.sourcePath).toBe('.atlas/review-policy.json');
    expect(effectivePolicy.provenance.loadError?.code).toBe('invalid_json');
    expect(effectivePolicy.defaults.requireEvidence).toBe(true);
    expect(effectivePolicy.promptAppend).toEqual([]);
  });

  it('can load the working tree policy for local preview runs', async () => {
    await fs.writeFile(
      path.join(repoDir, '.atlas', 'review-policy.json'),
      JSON.stringify({
        version: 1,
        promptAppend: ['Trusted main guidance.'],
      }, null, 2),
      'utf8'
    );
    await runGit(repoDir, 'add', '.');
    await runGit(repoDir, 'commit', '-m', 'chore: add trusted review policy');

    await runGit(repoDir, 'checkout', '-b', 'feature/local-policy-preview');
    await fs.writeFile(
      path.join(repoDir, '.atlas', 'review-policy.json'),
      JSON.stringify({
        version: 1,
        promptAppend: ['Working tree preview guidance.'],
      }, null, 2),
      'utf8'
    );

    const effectivePolicy = await resolveEffectiveReviewPolicy({
      projectPath: repoDir,
      reviewType: 'branch_review',
      reviewProfile: null,
      baseBranch: 'main',
      policySource: 'working_tree',
    });

    expect(effectivePolicy.provenance.policySource).toBe('working_tree');
    expect(effectivePolicy.provenance.trustedRef).toBeNull();
    expect(effectivePolicy.promptAppend).toContain('Working tree preview guidance.');
    expect(effectivePolicy.promptAppend).not.toContain('Trusted main guidance.');
  });

  it('uses the generated project policy baseline when no repo policy file exists', async () => {
    await fs.mkdir(path.join(repoDir, 'internal'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'go.mod'), "module example.com/demo\n\ngo 1.22\n", 'utf8');
    await fs.writeFile(path.join(repoDir, 'internal', 'service.go'), 'package internal\n', 'utf8');

    const generatedProjectPolicy = createGeneratedProjectReviewPolicyBaseline(repoDir);

    const effectivePolicy = await resolveEffectiveReviewPolicy({
      projectPath: repoDir,
      reviewType: 'branch_review',
      reviewProfile: null,
      baseBranch: 'main',
      generatedProjectPolicy,
    });

    expect(effectivePolicy.promptAppend).toEqual([]);
    expect(effectivePolicy.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ glob: 'internal/**', fileClass: 'deep' }),
      expect.objectContaining({ glob: '**/*.go', fileClass: 'deep' }),
    ]));
    expect(effectivePolicy.provenance.sourcePath).toBe('atlas:generated-project-review-policy');
    expect(effectivePolicy.provenance.layersApplied).toContain('generated_project_policy');
  });

  it('strips the legacy built-in prompt guidance from stored generated policies', async () => {
    const stored = parseStoredGeneratedProjectReviewPolicy({
      generated_review_policy_json: JSON.stringify({
        version: 1,
        defaults: {
          requireEvidence: true,
          allowPraise: false,
          maxRecommendations: 8,
        },
        promptAppend: [
          'Prioritize correctness, regressions, security, data loss, and missing tests. Avoid style-only feedback unless it materially affects maintainability.',
        ],
        paths: [
          { glob: 'internal/**/*.go', fileClass: 'deep' },
        ],
      }),
      generated_review_policy_hash: 'stale-hash',
      generated_review_policy_version: 1,
      generated_review_policy_generator_version: 'stack_aware_v1',
    });

    expect(stored.loadError).toBeNull();
    expect(stored.policy?.promptAppend).toEqual([]);
    expect(stored.content).toContain('"promptAppend": []');
    expect(stored.hash).not.toBe('stale-hash');
  });

  it('persists sanitized generated policy metadata when stored content is stale', async () => {
    const stored = await ensureGeneratedProjectReviewPolicy({
      id: 'proj-1',
      path: repoDir,
      generated_review_policy_json: JSON.stringify({
        version: 1,
        defaults: {
          requireEvidence: true,
          allowPraise: false,
          maxRecommendations: 8,
        },
        promptAppend: [
          'Prioritize correctness, regressions, security, data loss, and missing tests. Avoid style-only feedback unless it materially affects maintainability.',
        ],
        paths: [],
      }),
      generated_review_policy_hash: 'stale-hash',
      generated_review_policy_version: 1,
      generated_review_policy_generator_version: 'stack_aware_v1',
      generated_review_policy_generated_at: '2026-04-01T00:00:00.000Z',
    });

    expect(stored.policy?.promptAppend).toEqual([]);
    expect(updateProjectGeneratedReviewPolicyMock).toHaveBeenCalledWith('proj-1', expect.objectContaining({
      generatedReviewPolicyJson: expect.stringContaining('"promptAppend": []'),
      generatedReviewPolicyHash: stored.hash,
      generatedReviewPolicyVersion: stored.version,
    }));
  });

  it('generates smart linter defaults from repo-owned config, not installed binaries', async () => {
    await fs.writeFile(path.join(repoDir, 'eslint.config.js'), 'export default [];\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'tsconfig.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(repoDir, '.semgrep.yml'), 'rules: []\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'App.csproj'), '<Project />\n', 'utf8');

    const doc = createDefaultReviewPolicyDocument(repoDir);

    expect(doc.linters).toEqual({
      enabled: true,
      mode: 'fallback_if_missing',
      eslint: { enabled: true },
      tsc: { enabled: true },
      dotnet: { enabled: true },
      dotnetFormat: { enabled: false },
      semgrep: { enabled: true, allowAtlasManagedFallback: true },
    });
  });

  it('enables Semgrep fallback in starter policy when Atlas-managed analysis is available', async () => {
    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'src', 'app.ts'), 'export const ok = true;\n', 'utf8');

    const doc = createDefaultReviewPolicyDocument(repoDir);

    expect(doc.linters).toEqual(expect.objectContaining({
      enabled: true,
      mode: 'fallback_if_missing',
      semgrep: {
        enabled: true,
        allowAtlasManagedFallback: true,
      },
    }));
  });

  it('preserves repo linter policy in the effective review policy', async () => {
    await fs.writeFile(
      path.join(repoDir, '.atlas', 'review-policy.json'),
      JSON.stringify({
        version: 1,
        linters: {
          enabled: true,
          eslint: { enabled: true },
          tsc: { enabled: false },
          dotnet: { enabled: false },
          dotnetFormat: { enabled: true },
          semgrep: { enabled: false },
        },
      }, null, 2),
      'utf8'
    );
    await runGit(repoDir, 'add', '.');
    await runGit(repoDir, 'commit', '-m', 'chore: add linter policy');

    const effectivePolicy = await resolveEffectiveReviewPolicy({
      projectPath: repoDir,
      reviewType: 'branch_review',
      reviewProfile: null,
      baseBranch: 'main',
    });

    expect(effectivePolicy.linters).toEqual({
      enabled: true,
      eslint: { enabled: true },
      tsc: { enabled: false },
      dotnet: { enabled: false },
      dotnetFormat: { enabled: true },
      semgrep: { enabled: false },
    });
  });

  it('detects modern test extensions and bun.lock in smart path defaults', async () => {
    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'src', 'feature.test.mjs'), 'export const ok = true;\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'src', 'feature.spec.cts'), 'export = {};\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'bun.lock'), 'lockfileVersion = 1\n', 'utf8');

    const doc = createDefaultReviewPolicyDocument(repoDir);

    expect(doc.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ glob: '**/*.test.*', fileClass: 'shallow' }),
      expect.objectContaining({ glob: '**/*.spec.*', fileClass: 'shallow' }),
      expect.objectContaining({ glob: '**/bun.lock', fileClass: 'collapsed' }),
    ]));
  });

  it('collapses generated protobuf outputs and protobuf lockfiles in smart path defaults', async () => {
    await fs.mkdir(path.join(repoDir, 'proto'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'proto', 'service.proto'), 'syntax = "proto3";\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'proto', 'service.pb.go'), 'package proto\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'buf.lock'), 'deps: []\n', 'utf8');

    const doc = createDefaultReviewPolicyDocument(repoDir);

    expect(doc.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ glob: '**/*.pb.go', fileClass: 'collapsed' }),
      expect.objectContaining({ glob: '**/buf.lock', fileClass: 'collapsed' }),
    ]));
  });

  it('prefers tracked-file signals so ignored build outputs do not become starter path rules', async () => {
    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'src', 'feature.test.ts'), 'export const ok = true;\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'package-lock.json'), '{\"lockfileVersion\":3}\n', 'utf8');
    await fs.writeFile(path.join(repoDir, '.gitignore'), 'dist/\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'dist', 'bundle.js'), 'console.log("ignored");\n', 'utf8');

    await runGit(repoDir, 'add', 'src/feature.test.ts', 'package-lock.json', '.gitignore');
    await runGit(repoDir, 'commit', '-m', 'chore: tracked policy signals');

    const doc = createDefaultReviewPolicyDocument(repoDir);
    const globs = doc.paths.map((entry) => entry.glob);

    expect(globs).toContain('**/*.test.*');
    expect(globs).toContain('**/package-lock.json');
    expect(globs).not.toContain('**/dist/**');
  });

  it('adds Unity-specific path rules when a Unity project root is detected', async () => {
    await fs.mkdir(path.join(repoDir, 'ProjectSettings'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'Assets', 'Scripts'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n', 'utf8');

    const doc = createDefaultReviewPolicyDocument(repoDir);

    expect(doc.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ glob: '**/*.meta', fileClass: 'collapsed' }),
      expect.objectContaining({ glob: 'UserSettings/**', fileClass: 'collapsed' }),
      expect.objectContaining({ glob: '**/*.sln', fileClass: 'collapsed' }),
      expect.objectContaining({ glob: 'ProjectSettings/**', fileClass: 'deep' }),
      expect.objectContaining({ glob: 'Assets/Scripts/**', fileClass: 'deep' }),
      expect.objectContaining({ glob: 'Assets/**/*.prefab', fileClass: 'structural' }),
      expect.objectContaining({ glob: 'Library/**', fileClass: 'skip' }),
      expect.objectContaining({ glob: 'UserSettings/Layouts/**', fileClass: 'skip' }),
    ]));
  });

  it('generates Unity path rules only for the selected primary Unity root', async () => {
    const unityRoot = path.join(repoDir, 'Project_BLACK', 'BLACK_Unity');
    const fmodRoot = path.join(repoDir, 'Project_BLACK', 'BLACK_FMOD');

    await fs.mkdir(path.join(unityRoot, 'ProjectSettings'), { recursive: true });
    await fs.mkdir(path.join(unityRoot, 'Assets', 'Scripts'), { recursive: true });
    await fs.mkdir(path.join(unityRoot, 'Packages'), { recursive: true });
    await fs.writeFile(path.join(unityRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n', 'utf8');
    await fs.writeFile(path.join(unityRoot, 'Packages', 'manifest.json'), '{}\n', 'utf8');

    await fs.mkdir(path.join(fmodRoot, 'ProjectSettings'), { recursive: true });
    await fs.mkdir(path.join(fmodRoot, 'Assets'), { recursive: true });
    await fs.writeFile(path.join(fmodRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n', 'utf8');

    const doc = createDefaultReviewPolicyDocument(repoDir);
    const globs = doc.paths.map((entry) => entry.glob);

    expect(globs).toContain('Project_BLACK/BLACK_Unity/Assets/Scripts/**');
    expect(globs).toContain('Project_BLACK/BLACK_Unity/ProjectSettings/**');
    expect(globs).not.toContain('Project_BLACK/BLACK_FMOD/Assets/Scripts/**');
    expect(globs).not.toContain('Project_BLACK/BLACK_FMOD/ProjectSettings/**');
  });

  it('adds stack-aware path rules for common backend, mobile, and infrastructure projects', async () => {
    await fs.mkdir(path.join(repoDir, 'go-service', 'internal'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'go-service', 'proto'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'go-service', 'go.mod'), "module example.com/go-service\n\ngo 1.22\n", 'utf8');
    await fs.writeFile(path.join(repoDir, 'go-service', 'internal', 'runtime.go'), 'package internal\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'go-service', 'internal', 'runtime_test.go'), 'package internal\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'go-service', 'proto', 'service.proto'), 'syntax = "proto3";\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'go-service', 'buf.yaml'), 'version: v1\n', 'utf8');

    await fs.mkdir(path.join(repoDir, 'rails', 'config'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'rails', 'app'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'rails', 'Gemfile'), "source 'https://rubygems.org'\n", 'utf8');
    await fs.writeFile(path.join(repoDir, 'rails', 'config', 'application.rb'), 'module Demo; end\n', 'utf8');

    await fs.mkdir(path.join(repoDir, 'python', 'tests'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'python', 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');

    await fs.mkdir(path.join(repoDir, 'android', 'app', 'src', 'main', 'res'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'android', 'settings.gradle.kts'), 'rootProject.name = "demo"\n', 'utf8');

    await fs.mkdir(path.join(repoDir, 'infra', 'terraform'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'infra', 'main.tf'), 'terraform {}\n', 'utf8');

    await fs.mkdir(path.join(repoDir, 'ios', 'Sources'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'ios', 'Package.swift'), '// swift-tools-version: 5.9\n', 'utf8');

    await fs.mkdir(path.join(repoDir, 'unreal', 'Source'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'unreal', 'Config'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'unreal', 'Game.uproject'), '{}\n', 'utf8');

    await fs.mkdir(path.join(repoDir, 'laravel', 'app'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'laravel', 'routes'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'laravel', 'artisan'), '#!/usr/bin/env php\n', 'utf8');

    await fs.mkdir(path.join(repoDir, 'phoenix', 'lib'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'phoenix', 'config'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'phoenix', 'mix.exs'), 'defmodule Demo.MixProject do end\n', 'utf8');

    const doc = createDefaultReviewPolicyDocument(repoDir);

    expect(doc.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ glob: 'go-service/**/*_test.go', fileClass: 'shallow' }),
      expect.objectContaining({ glob: 'go-service/**/*.go', fileClass: 'deep' }),
      expect.objectContaining({
        glob: 'go-service/**/*.proto',
        fileClass: 'structural',
        promptAppend: expect.stringContaining('backward compatibility'),
      }),
      expect.objectContaining({ glob: 'go-service/buf.yaml', fileClass: 'structural' }),
      expect.objectContaining({ glob: 'rails/app/**', fileClass: 'deep' }),
      expect.objectContaining({ glob: 'rails/spec/**', fileClass: 'shallow' }),
      expect.objectContaining({ glob: 'python/tests/**', fileClass: 'shallow' }),
      expect.objectContaining({ glob: 'python/**/*.py', fileClass: 'deep' }),
      expect.objectContaining({ glob: 'android/app/src/main/res/**', fileClass: 'structural' }),
      expect.objectContaining({ glob: 'android/**/*.kt', fileClass: 'deep' }),
      expect.objectContaining({ glob: 'infra/terraform/**', fileClass: 'structural' }),
      expect.objectContaining({ glob: 'infra/**/*.tf', fileClass: 'deep' }),
      expect.objectContaining({ glob: 'ios/**/*.xcodeproj/project.pbxproj', fileClass: 'structural' }),
      expect.objectContaining({ glob: 'ios/**/*.swift', fileClass: 'deep' }),
      expect.objectContaining({ glob: 'unreal/Content/**', fileClass: 'structural' }),
      expect.objectContaining({ glob: 'unreal/**/*.uproject', fileClass: 'deep' }),
      expect.objectContaining({ glob: 'laravel/resources/views/**', fileClass: 'structural' }),
      expect.objectContaining({ glob: 'laravel/**/*.php', fileClass: 'deep' }),
      expect.objectContaining({ glob: 'phoenix/lib/**', fileClass: 'deep' }),
      expect.objectContaining({ glob: 'phoenix/**/*.exs', fileClass: 'deep' }),
    ]));
  });

  it('does not re-enable global linters when a later layer omits the enabled flag', () => {
    const merged = mergeReviewPolicyLayers(
      {
        version: 1,
        linters: {
          enabled: false,
          eslint: { enabled: false },
        },
      },
      {
        version: 1,
        linters: {
          eslint: { enabled: true },
        },
      }
    );

    expect(merged.linters).toEqual({
      enabled: false,
      eslint: { enabled: true },
    });
  });

  it('does not materialize global enabled when both linter layers omit it', () => {
    const merged = mergeReviewPolicyLayers(
      {
        version: 1,
        linters: {
          eslint: { enabled: false },
        },
      },
      {
        version: 1,
        linters: {
          semgrep: { enabled: true },
        },
      }
    );

    expect(merged.linters).toEqual({
      eslint: { enabled: false },
      semgrep: { enabled: true },
    });
    expect(Object.prototype.hasOwnProperty.call(merged.linters, 'enabled')).toBe(false);
  });

  it('merges linter mode and tool fallback flags without forcing unrelated fields', () => {
    const merged = mergeReviewPolicyLayers(
      {
        version: 1,
        linters: {
          mode: 'project_only',
          semgrep: { enabled: true },
        },
      },
      {
        version: 1,
        linters: {
          mode: 'fallback_if_missing',
          semgrep: { allowAtlasManagedFallback: true },
        },
      }
    );

    expect(merged.linters).toEqual({
      mode: 'fallback_if_missing',
      semgrep: {
        enabled: true,
        allowAtlasManagedFallback: true,
      },
    });
  });

  describe('applyReviewPolicyToReviewProfile largeReviewStructuralSkip', () => {
    function buildBaseProfile(structuralPaths = []) {
      const structuralSet = new Set(structuralPaths);
      return {
        id: 'unity_csharp',
        classifyEntry(entry) {
          const className = structuralSet.has(entry?.path) ? 'structural' : 'deep';
          return {
            fileClass: className,
            reason: 'profile',
            pairWithSiblingMeta: false,
            riskBoost: 0,
            sizeMultiplier: 1,
          };
        },
      };
    }

    it('demotes structural to skip when totalFiles meets the threshold and the policy default is on', () => {
      const profile = buildBaseProfile(['Assets/Scenes/Main.unity']);
      const wrapped = applyReviewPolicyToReviewProfile(
        profile,
        { defaults: { largeReviewStructuralSkip: true }, paths: [] },
        { totalFiles: 150 },
      );

      const structural = wrapped.classifyEntry({ path: 'Assets/Scenes/Main.unity' });
      const deep = wrapped.classifyEntry({ path: 'Assets/Scripts/Player.cs' });
      expect(structural.fileClass).toBe('skip');
      expect(structural.reason).toMatch(/^large_review_structural_skip:150>=/);
      expect(deep.fileClass).toBe('deep');
    });

    it('does not demote structural on small reviews', () => {
      const profile = buildBaseProfile(['Assets/Scenes/Main.unity']);
      const wrapped = applyReviewPolicyToReviewProfile(
        profile,
        { defaults: { largeReviewStructuralSkip: true }, paths: [] },
        { totalFiles: 12 },
      );

      const structural = wrapped.classifyEntry({ path: 'Assets/Scenes/Main.unity' });
      expect(structural.fileClass).toBe('structural');
      expect(structural.reason).toBe('profile');
    });

    it('honors largeReviewStructuralSkip:false even on huge reviews', () => {
      const profile = buildBaseProfile(['Assets/Scenes/Main.unity']);
      const wrapped = applyReviewPolicyToReviewProfile(
        profile,
        { defaults: { largeReviewStructuralSkip: false }, paths: [] },
        { totalFiles: 500 },
      );

      const structural = wrapped.classifyEntry({ path: 'Assets/Scenes/Main.unity' });
      expect(structural.fileClass).toBe('structural');
    });

    it('treats omitted policy.defaults as opt-in (default true)', () => {
      const profile = buildBaseProfile(['Assets/Scenes/Main.unity']);
      const wrapped = applyReviewPolicyToReviewProfile(
        profile,
        { paths: [] },
        { totalFiles: 200 },
      );

      const structural = wrapped.classifyEntry({ path: 'Assets/Scenes/Main.unity' });
      expect(structural.fileClass).toBe('skip');
    });

    it('preserves explicit path-rule overrides before structural demotion runs', () => {
      // A repo that explicitly pins a scene to deep should keep that classification
      // even on a large review — path overrides are repo-author intent.
      const profile = buildBaseProfile(['Assets/Scenes/Main.unity', 'Assets/Scenes/Boss.unity']);
      const wrapped = applyReviewPolicyToReviewProfile(
        profile,
        {
          defaults: { largeReviewStructuralSkip: true },
          paths: [
            { glob: 'Assets/Scenes/Boss.unity', fileClass: 'deep' },
          ],
        },
        { totalFiles: 250 },
      );

      const pinned = wrapped.classifyEntry({ path: 'Assets/Scenes/Boss.unity' });
      const demoted = wrapped.classifyEntry({ path: 'Assets/Scenes/Main.unity' });
      expect(pinned.fileClass).toBe('deep');
      expect(demoted.fileClass).toBe('skip');
    });

    it('skipAllStructuralFiles demotes structural even on tiny reviews', () => {
      const profile = buildBaseProfile(['Assets/Scenes/Main.unity']);
      const wrapped = applyReviewPolicyToReviewProfile(
        profile,
        { defaults: { skipAllStructuralFiles: true, largeReviewStructuralSkip: false }, paths: [] },
        { totalFiles: 3 },
      );

      const structural = wrapped.classifyEntry({ path: 'Assets/Scenes/Main.unity' });
      const deep = wrapped.classifyEntry({ path: 'Assets/Scripts/Player.cs' });
      expect(structural.fileClass).toBe('skip');
      expect(structural.reason).toBe('skip_all_structural_files');
      expect(deep.fileClass).toBe('deep');
    });

    it('skipAllStructuralFiles wins over largeReviewStructuralSkip in the reason string', () => {
      const profile = buildBaseProfile(['Assets/Scenes/Main.unity']);
      const wrapped = applyReviewPolicyToReviewProfile(
        profile,
        { defaults: { skipAllStructuralFiles: true, largeReviewStructuralSkip: true }, paths: [] },
        { totalFiles: 500 },
      );

      const structural = wrapped.classifyEntry({ path: 'Assets/Scenes/Main.unity' });
      expect(structural.fileClass).toBe('skip');
      expect(structural.reason).toBe('skip_all_structural_files');
    });

    it('skipAllStructuralFiles still respects deep path overrides', () => {
      const profile = buildBaseProfile(['Assets/Scenes/Main.unity', 'Assets/Scenes/Boss.unity']);
      const wrapped = applyReviewPolicyToReviewProfile(
        profile,
        {
          defaults: { skipAllStructuralFiles: true },
          paths: [
            { glob: 'Assets/Scenes/Boss.unity', fileClass: 'deep' },
          ],
        },
        { totalFiles: 5 },
      );

      const pinned = wrapped.classifyEntry({ path: 'Assets/Scenes/Boss.unity' });
      const demoted = wrapped.classifyEntry({ path: 'Assets/Scenes/Main.unity' });
      expect(pinned.fileClass).toBe('deep');
      expect(demoted.fileClass).toBe('skip');
    });

    it('skipAllStructuralFiles defaults to off when omitted', () => {
      const profile = buildBaseProfile(['Assets/Scenes/Main.unity']);
      const wrapped = applyReviewPolicyToReviewProfile(
        profile,
        { defaults: { largeReviewStructuralSkip: false }, paths: [] },
        { totalFiles: 5 },
      );

      const structural = wrapped.classifyEntry({ path: 'Assets/Scenes/Main.unity' });
      expect(structural.fileClass).toBe('structural');
    });
  });
});
