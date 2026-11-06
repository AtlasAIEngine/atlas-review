/**
 * walkthroughGeneration unit tests.
 *
 * Phase 11 — verify the walkthrough-only pipeline:
 * - cheap-model path resolves to provider triage tier
 * - opt-out path resolves to the review tier
 * - persists via walkthroughService on success
 * - parse-recovery seam handles malformed JSON gracefully
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const saveWalkthroughMock = vi.fn();
const getWalkthroughMock = vi.fn();

vi.mock('../../walkthroughService.js', () => ({
  default: {
    saveWalkthrough: (...args) => saveWalkthroughMock(...args),
    getWalkthrough: (...args) => getWalkthroughMock(...args),
  },
  saveWalkthrough: (...args) => saveWalkthroughMock(...args),
  getWalkthrough: (...args) => getWalkthroughMock(...args),
}));

const cacheGetManyMock = vi.fn(async () => new Map());
const cachePutManyMock = vi.fn(async () => undefined);

vi.mock('../../walkthroughFileCacheService.js', async () => {
  const actual = await vi.importActual('../../walkthroughFileCacheService.js');
  return {
    ...actual,
    default: {
      ...actual.default,
      getMany: (...args) => cacheGetManyMock(...args),
      putMany: (...args) => cachePutManyMock(...args),
    },
    getMany: (...args) => cacheGetManyMock(...args),
    putMany: (...args) => cachePutManyMock(...args),
  };
});

import { generateWalkthrough, buildWalkthroughPrompt } from '../walkthroughGeneration.js';
import providerService from '../../providerService.js';

const { REVIEW_MODEL_DEFAULTS } = providerService;

beforeEach(() => {
  vi.clearAllMocks();
  saveWalkthroughMock.mockResolvedValue({ id: 'wt-1' });
  getWalkthroughMock.mockResolvedValue(null);
  cacheGetManyMock.mockResolvedValue(new Map());
  cachePutManyMock.mockResolvedValue(undefined);
});

const SAMPLE_DIFF = `diff --git a/src/auth.js b/src/auth.js
index abc..def 100644
--- a/src/auth.js
+++ b/src/auth.js
@@ -1,3 +1,4 @@
 export function login() {
+  return validate();
 }
`;

const STRUCTURED_RESPONSE = JSON.stringify({
  changeGroups: [
    {
      label: 'Tighten login',
      description: 'Adds validation to login()',
      risk: 'low',
      files: [
        { path: 'src/auth.js', additions: 1, deletions: 0, description: 'add validate() call' },
      ],
    },
  ],
});

const TWO_FILE_DIFF = `${SAMPLE_DIFF}
diff --git a/frontend/src/App.tsx b/frontend/src/App.tsx
index 111..222 100644
--- a/frontend/src/App.tsx
+++ b/frontend/src/App.tsx
@@ -1,3 +1,4 @@
 export function App() {
+  return <main />;
 }
`;

function buildMultiFileDiff(count) {
  return Array.from({ length: count }, (_, index) => {
    const fileIndex = index + 1;
    return `diff --git a/src/file${fileIndex}.js b/src/file${fileIndex}.js
index 111..222 100644
--- a/src/file${fileIndex}.js
+++ b/src/file${fileIndex}.js
@@ -1,3 +1,4 @@
 export const value${fileIndex} = ${fileIndex};
+export const next${fileIndex} = ${fileIndex + 1};
`;
  }).join('\n');
}

function buildFileSummaries(count) {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/file${index + 1}.js`,
    additions: index + 1,
    deletions: index % 3,
  }));
}

describe('generateWalkthrough', () => {
  it('resolves to the triage-tier model when useCheapModel is true (default)', async () => {
    const providerCall = vi.fn().mockResolvedValue({
      text: STRUCTURED_RESPONSE,
      tokensUsed: { input: 120, output: 30 },
    });

    await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: SAMPLE_DIFF,
      providerType: 'anthropic',
      providerCall,
    });

    expect(providerCall).toHaveBeenCalledTimes(1);
    const callArgs = providerCall.mock.calls[0][0];
    expect(callArgs.model).toBe(REVIEW_MODEL_DEFAULTS.anthropic.walkthrough);
  });

  it('resolves to the review-tier model when useCheapModel is false', async () => {
    const providerCall = vi.fn().mockResolvedValue({
      text: STRUCTURED_RESPONSE,
      tokensUsed: { input: 120, output: 30 },
    });

    await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: SAMPLE_DIFF,
      providerType: 'anthropic',
      useCheapModel: false,
      providerCall,
    });

    const callArgs = providerCall.mock.calls[0][0];
    expect(callArgs.model).toBe(REVIEW_MODEL_DEFAULTS.anthropic.review);
  });

  it('persists the walkthrough on success via saveWalkthrough', async () => {
    const providerCall = vi.fn().mockResolvedValue({
      text: STRUCTURED_RESPONSE,
      tokensUsed: { input: 120, output: 30 },
      executionMode: 'api',
    });

    const result = await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: SAMPLE_DIFF,
      providerType: 'anthropic',
      providerCall,
    });

    expect(saveWalkthroughMock).toHaveBeenCalledTimes(1);
    const persisted = saveWalkthroughMock.mock.calls[0][0];
    expect(persisted.projectId).toBe('proj-1');
    expect(persisted.baseSha).toBe('base');
    expect(persisted.headSha).toBe('head');
    expect(Array.isArray(persisted.changeGroups)).toBe(true);
    expect(persisted.changeGroups[0].label).toBe('Tighten login');
    expect(persisted.providerType).toBe('anthropic');
    expect(persisted.modelId).toBe(REVIEW_MODEL_DEFAULTS.anthropic.walkthrough);
    expect(persisted.runMetadata).toMatchObject({
      strategy: 'walkthrough cheap tier',
      mode: 'single-pass',
      providerType: 'anthropic',
      modelId: REVIEW_MODEL_DEFAULTS.anthropic.walkthrough,
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      providerCallCount: 1,
      executionMode: 'api',
      executionModes: ['api'],
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].label).toBe('Tighten login');
  });

  it('does not treat zero native cost with missing tokens as reported provider cost', async () => {
    const providerCall = vi.fn().mockResolvedValue({
      text: STRUCTURED_RESPONSE,
      tokensUsed: { input: 0, output: 0 },
      costUsd: 0,
      executionMode: 'cli-pipe',
    });

    await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: SAMPLE_DIFF,
      providerType: 'anthropic',
      providerCall,
    });

    const persisted = saveWalkthroughMock.mock.calls[0][0];
    expect(persisted.runMetadata).toEqual(expect.objectContaining({
      providerCallCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerNativeCost: null,
      estimatedCost: 0,
      costSource: 'pricing_table',
      executionMode: 'cli-pipe',
    }));
  });

  it('does not treat scalar tokensUsed as walkthrough output tokens', async () => {
    const providerCall = vi.fn().mockResolvedValue({
      text: STRUCTURED_RESPONSE,
      tokensUsed: 77,
    });

    await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: SAMPLE_DIFF,
      providerType: 'anthropic',
      providerCall,
    });

    const persisted = saveWalkthroughMock.mock.calls[0][0];
    expect(persisted.runMetadata).toEqual(expect.objectContaining({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }));
  });

  it('falls through parse-recovery on malformed JSON without throwing', async () => {
    // Wrap structured response in markdown fences and trailing junk to
    // trigger the same recovery path the review parser uses.
    const wrapped = '```json\n' + STRUCTURED_RESPONSE + '\n```\n\nextra prose';
    const providerCall = vi.fn().mockResolvedValue({ text: wrapped });

    const result = await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: SAMPLE_DIFF,
      providerType: 'anthropic',
      providerCall,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Tighten login');
  });

  it('rejects truly unusable provider output without saving fallback groups', async () => {
    const providerCall = vi.fn().mockResolvedValue({ text: 'not json at all, no salvage possible' });

    await expect(generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: SAMPLE_DIFF,
      providerType: 'anthropic',
      providerCall,
    })).rejects.toThrow('unusable output');

    expect(saveWalkthroughMock).not.toHaveBeenCalled();
  });

  it('surfaces provider call failures without saving fallback groups', async () => {
    const providerCall = vi.fn().mockRejectedValue(new Error('provider unavailable'));

    await expect(generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: TWO_FILE_DIFF,
      providerType: 'anthropic',
      providerCall,
    })).rejects.toThrow('provider unavailable');

    expect(saveWalkthroughMock).not.toHaveBeenCalled();
  });

  it('augments partial model output so every diff file is covered', async () => {
    const providerCall = vi.fn().mockResolvedValue({ text: STRUCTURED_RESPONSE });

    const result = await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: TWO_FILE_DIFF,
      providerType: 'anthropic',
      providerCall,
    });

    const coveredPaths = result.flatMap((group) => group.files.map((file) => file.path));
    expect(coveredPaths).toContain('src/auth.js');
    expect(coveredPaths).toContain('frontend/src/App.tsx');
    expect(new Set(coveredPaths).size).toBe(coveredPaths.length);
    expect(saveWalkthroughMock.mock.calls[0][0].changeGroups.flatMap((group) => group.files)).toHaveLength(2);
  });

  it('uses supplied file summaries when the diff excerpt is truncated', async () => {
    const providerCall = vi.fn().mockResolvedValue({ text: STRUCTURED_RESPONSE });

    const result = await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: `${SAMPLE_DIFF}\n\n... (diff truncated before walkthrough generation)`,
      fileSummaries: [
        { path: 'src/auth.js', additions: 1, deletions: 0 },
        { path: 'mobile/ExampleProject.cs', additions: 2000, deletions: 100 },
      ],
      providerType: 'anthropic',
      providerCall,
    });

    const prompt = providerCall.mock.calls[0][0].prompt;
    expect(prompt).toContain('- mobile/ExampleProject.cs (+2000 -100)');
    const coveredPaths = result.flatMap((group) => group.files.map((file) => file.path));
    expect(coveredPaths).toContain('src/auth.js');
    expect(coveredPaths).toContain('mobile/ExampleProject.cs');
  });

  it('covers deleted files deterministically without an LLM call', async () => {
    const providerCall = vi.fn();

    const result = await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: SAMPLE_DIFF,
      fileSummaries: [
        { path: 'Assets/Obsolete.asset', additions: 0, deletions: 7000, status: 'D' },
      ],
      providerType: 'anthropic',
      providerCall,
    });

    expect(providerCall).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        label: 'Deleted files',
        files: [
          expect.objectContaining({
            path: 'Assets/Obsolete.asset',
            description: 'Deleted in this diff.',
          }),
        ],
      }),
    ]);
  });

  it('uses deterministic fallback coverage for huge manifests the provider cannot enumerate', async () => {
    const hugeFileSummaries = buildFileSummaries(300);
    const sparseResponse = JSON.stringify({
      changeGroups: [
        {
          label: 'Representative source changes',
          description: 'Covers the representative file the model inspected.',
          risk: 'low',
          files: [
            { path: 'src/file1.js', additions: 1, deletions: 0, description: 'Representative file.' },
          ],
        },
      ],
    });
    const providerCall = vi.fn().mockResolvedValue({ text: sparseResponse });

    const result = await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: `${SAMPLE_DIFF}\n\n... (diff truncated before walkthrough generation)`,
      fileSummaries: hugeFileSummaries,
      providerType: 'anthropic',
      providerCall,
    });

    const coveredPaths = result.flatMap((group) => group.files.map((file) => file.path));
    expect(coveredPaths).toContain('src/file1.js');
    expect(coveredPaths).toContain('src/file300.js');
    expect(new Set(coveredPaths).size).toBe(300);
    expect(saveWalkthroughMock).toHaveBeenCalledTimes(1);
  });

  it('falls back deterministically for unusable provider output on huge manifests', async () => {
    const providerCall = vi.fn().mockResolvedValue({ text: 'not json' });

    const result = await generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: `${SAMPLE_DIFF}\n\n... (diff truncated before walkthrough generation)`,
      fileSummaries: buildFileSummaries(300),
      providerType: 'anthropic',
      providerCall,
    });

    const coveredPaths = result.flatMap((group) => group.files.map((file) => file.path));
    expect(coveredPaths).toHaveLength(300);
    expect(coveredPaths).toContain('src/file300.js');
  });

  it('rejects provider output that only names hallucinated paths before fallback coverage is appended', async () => {
    const hallucinatedResponse = JSON.stringify({
      changeGroups: [
        {
          label: 'Imaginary work',
          description: 'Mentions a file that is not in the manifest.',
          risk: 'low',
          files: [
            { path: 'src/ghost.js', additions: 1, deletions: 0, description: 'not in diff' },
          ],
        },
      ],
    });
    const providerCall = vi.fn().mockResolvedValue({ text: hallucinatedResponse });

    await expect(generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: SAMPLE_DIFF,
      providerType: 'anthropic',
      providerCall,
    })).rejects.toThrow('no valid diff files');

    expect(saveWalkthroughMock).not.toHaveBeenCalled();
  });

  it('rejects very low manifest coverage instead of saving mostly fallback groups', async () => {
    const largeDiff = buildMultiFileDiff(8);
    const undercoveredResponse = JSON.stringify({
      changeGroups: [
        {
          label: 'Tiny slice',
          description: 'Only covers one file from a larger manifest.',
          risk: 'low',
          files: [
            { path: 'src/file1.js', additions: 1, deletions: 0, description: 'covered' },
          ],
        },
      ],
    });
    const providerCall = vi.fn().mockResolvedValue({ text: undercoveredResponse });

    await expect(generateWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      diff: largeDiff,
      providerType: 'anthropic',
      providerCall,
    })).rejects.toThrow('covered too few diff files');

    expect(saveWalkthroughMock).not.toHaveBeenCalled();
  });

  it('validates required parameters', async () => {
    const providerCall = vi.fn();
    await expect(generateWalkthrough({
      projectId: '', baseSha: 'b', headSha: 'h', diff: '', providerType: 'anthropic', providerCall,
    })).rejects.toThrow();
    await expect(generateWalkthrough({
      projectId: 'p', baseSha: '', headSha: 'h', diff: '', providerType: 'anthropic', providerCall,
    })).rejects.toThrow();
    await expect(generateWalkthrough({
      projectId: 'p', baseSha: 'b', headSha: '', diff: '', providerType: 'anthropic', providerCall,
    })).rejects.toThrow();
    expect(providerCall).not.toHaveBeenCalled();
  });

  describe('tier escalation (single-pass)', () => {
    it('does NOT escalate when the cheap-tier output is good', async () => {
      const providerCall = vi.fn().mockResolvedValue({ text: STRUCTURED_RESPONSE });

      await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff: SAMPLE_DIFF,
        providerType: 'anthropic',
        providerCall,
      });

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(providerCall.mock.calls[0][0].model).toBe(REVIEW_MODEL_DEFAULTS.anthropic.walkthrough);
    });

    it('escalates to the frontier model when the cheap output is unparseable', async () => {
      const providerCall = vi.fn()
        .mockResolvedValueOnce({ text: 'not parseable garbage' })
        .mockResolvedValueOnce({ text: STRUCTURED_RESPONSE });

      const result = await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff: SAMPLE_DIFF,
        providerType: 'anthropic',
        providerCall,
      });

      expect(providerCall).toHaveBeenCalledTimes(2);
      expect(providerCall.mock.calls[0][0].model).toBe(REVIEW_MODEL_DEFAULTS.anthropic.walkthrough);
      expect(providerCall.mock.calls[1][0].model).toBe(REVIEW_MODEL_DEFAULTS.anthropic.review);
      expect(result[0].label).toBe('Tighten login');
      // F2: the persisted modelId must reflect the escalated frontier model
      // that actually produced the saved walkthrough, not the up-front cheap
      // resolve.
      const persisted = saveWalkthroughMock.mock.calls[0][0];
      expect(persisted.modelId).toBe(REVIEW_MODEL_DEFAULTS.anthropic.review);
    });

    it('escalates when cheap-tier coverage is below the gate threshold', async () => {
      const sparseResponse = JSON.stringify({
        changeGroups: [{
          label: 'Minimal',
          description: 'Only one file.',
          risk: 'low',
          files: [{ path: 'src/auth.js', additions: 1, deletions: 0, description: 'fix' }],
        }],
      });
      const goodResponse = JSON.stringify({
        changeGroups: [{
          label: 'Both files',
          description: 'Covers the diff.',
          risk: 'low',
          files: [
            { path: 'src/auth.js', additions: 1, deletions: 0, description: 'fix' },
            { path: 'frontend/src/App.tsx', additions: 1, deletions: 0, description: 'render' },
            { path: 'src/router.js', additions: 1, deletions: 0, description: 'route' },
            { path: 'src/store.js', additions: 1, deletions: 0, description: 'state' },
          ],
        }],
      });
      const providerCall = vi.fn()
        .mockResolvedValueOnce({ text: sparseResponse })
        .mockResolvedValueOnce({ text: goodResponse });

      await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff: SAMPLE_DIFF, // diff content doesn't matter; fileSummaries drives the gate
        fileSummaries: [
          { path: 'src/auth.js', additions: 1, deletions: 0 },
          { path: 'frontend/src/App.tsx', additions: 1, deletions: 0 },
          { path: 'src/router.js', additions: 1, deletions: 0 },
          { path: 'src/store.js', additions: 1, deletions: 0 },
        ],
        providerType: 'anthropic',
        providerCall,
      });

      expect(providerCall).toHaveBeenCalledTimes(2);
      expect(providerCall.mock.calls[1][0].model).toBe(REVIEW_MODEL_DEFAULTS.anthropic.review);
    });

    it('does not escalate when useCheapModel is false (already on frontier)', async () => {
      const providerCall = vi.fn().mockResolvedValue({ text: 'unparseable' });

      await expect(generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff: SAMPLE_DIFF,
        providerType: 'anthropic',
        useCheapModel: false,
        providerCall,
      })).rejects.toThrow();

      expect(providerCall).toHaveBeenCalledTimes(1);
      expect(providerCall.mock.calls[0][0].model).toBe(REVIEW_MODEL_DEFAULTS.anthropic.review);
    });

    it('respects ATLAS_WALKTHROUGH_TIER_ESCALATION=false', async () => {
      const original = process.env.ATLAS_WALKTHROUGH_TIER_ESCALATION;
      process.env.ATLAS_WALKTHROUGH_TIER_ESCALATION = 'false';

      // Re-import the module so it picks up the env override.
      vi.resetModules();
      const { generateWalkthrough: gen } = await import('../walkthroughGeneration.js');

      try {
        const providerCall = vi.fn().mockResolvedValue({ text: 'unparseable' });
        await expect(gen({
          projectId: 'proj-1',
          baseSha: 'base',
          headSha: 'head',
          diff: SAMPLE_DIFF,
          providerType: 'anthropic',
          providerCall,
        })).rejects.toThrow();
        expect(providerCall).toHaveBeenCalledTimes(1);
      } finally {
        if (original === undefined) {
          delete process.env.ATLAS_WALKTHROUGH_TIER_ESCALATION;
        } else {
          process.env.ATLAS_WALKTHROUGH_TIER_ESCALATION = original;
        }
        vi.resetModules();
      }
    });
  });

  describe('per-file cache (single-pass)', () => {
    it('writes per-file descriptions back to the cache after a successful LLM call', async () => {
      const providerCall = vi.fn().mockResolvedValue({ text: STRUCTURED_RESPONSE });
      await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff: SAMPLE_DIFF,
        providerType: 'anthropic',
        providerCall,
      });

      // putMany is fire-and-forget; await a microtask to let the void promise settle.
      await Promise.resolve();
      expect(cachePutManyMock).toHaveBeenCalled();
      const entries = cachePutManyMock.mock.calls[0][0];
      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);
      const authEntry = entries.find((e) => e.summary.description.includes('validate'));
      expect(authEntry).toBeDefined();
      expect(authEntry.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('skips the LLM entirely when every file in the diff is in the cache', async () => {
      // Pre-populate the cache with a hit for the file in SAMPLE_DIFF.
      const fileDiffsResult = (await import('../walkthroughClustering.js'))
        .splitDiffByFile(SAMPLE_DIFF);
      const { computeFileCacheKey } = await import('../../walkthroughFileCacheService.js');
      const hash = computeFileCacheKey({ diffText: fileDiffsResult.get('src/auth.js') });
      cacheGetManyMock.mockResolvedValueOnce(new Map([
        [hash, { description: 'Cached description', risk: 'medium' }],
      ]));

      const providerCall = vi.fn();
      const result = await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff: SAMPLE_DIFF,
        providerType: 'anthropic',
        providerCall,
      });

      expect(providerCall).not.toHaveBeenCalled();
      expect(saveWalkthroughMock).toHaveBeenCalledTimes(1);
      const persisted = saveWalkthroughMock.mock.calls[0][0];
      const authFile = persisted.changeGroups.flatMap((g) => g.files).find((f) => f.path === 'src/auth.js');
      expect(authFile.description).toBe('Cached description');
      expect(persisted.runMetadata).toEqual(expect.objectContaining({
        cached: true,
        providerCallCount: 0,
        llmFileCount: 1,
        deterministicFileCount: 0,
        totalTokens: 0,
      }));
      expect(Array.isArray(result)).toBe(true);
    });

    it('runs the LLM normally when only some files are cached', async () => {
      // Two-file diff: one file is cached, the other is not. Single-pass
      // should still call the LLM since coverage isn't full.
      const fileDiffsResult = (await import('../walkthroughClustering.js'))
        .splitDiffByFile(TWO_FILE_DIFF);
      const { computeFileCacheKey } = await import('../../walkthroughFileCacheService.js');
      const hashAuth = computeFileCacheKey({ diffText: fileDiffsResult.get('src/auth.js') });
      cacheGetManyMock.mockResolvedValueOnce(new Map([
        [hashAuth, { description: 'Cached', risk: 'low' }],
      ]));

      const providerCall = vi.fn().mockResolvedValue({ text: STRUCTURED_RESPONSE });
      await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff: TWO_FILE_DIFF,
        providerType: 'anthropic',
        providerCall,
      });

      expect(providerCall).toHaveBeenCalledTimes(1);
    });

    it('bypasses cache reads when full regeneration requests a fresh LLM run', async () => {
      const fileDiffsResult = (await import('../walkthroughClustering.js'))
        .splitDiffByFile(SAMPLE_DIFF);
      const { computeFileCacheKey } = await import('../../walkthroughFileCacheService.js');
      const hash = computeFileCacheKey({ diffText: fileDiffsResult.get('src/auth.js') });
      cacheGetManyMock.mockResolvedValueOnce(new Map([
        [hash, { description: 'Cached description', risk: 'medium' }],
      ]));

      const providerCall = vi.fn().mockResolvedValue({ text: STRUCTURED_RESPONSE });
      await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff: SAMPLE_DIFF,
        providerType: 'anthropic',
        bypassFileCache: true,
        providerCall,
      });

      expect(cacheGetManyMock).not.toHaveBeenCalled();
      expect(providerCall).toHaveBeenCalledTimes(1);
      const persisted = saveWalkthroughMock.mock.calls[0][0];
      expect(persisted.runMetadata).toEqual(expect.objectContaining({
        cached: false,
        providerCallCount: 1,
      }));
    });

    it('respects ATLAS_WALKTHROUGH_FILE_CACHE=false', async () => {
      const original = process.env.ATLAS_WALKTHROUGH_FILE_CACHE;
      process.env.ATLAS_WALKTHROUGH_FILE_CACHE = 'false';

      vi.resetModules();
      const { generateWalkthrough: gen } = await import('../walkthroughGeneration.js');

      try {
        const providerCall = vi.fn().mockResolvedValue({ text: STRUCTURED_RESPONSE });
        await gen({
          projectId: 'proj-1',
          baseSha: 'base',
          headSha: 'head',
          diff: SAMPLE_DIFF,
          providerType: 'anthropic',
          providerCall,
        });
        // With cache disabled, neither getMany nor putMany should be called.
        expect(cacheGetManyMock).not.toHaveBeenCalled();
        expect(cachePutManyMock).not.toHaveBeenCalled();
      } finally {
        if (original === undefined) {
          delete process.env.ATLAS_WALKTHROUGH_FILE_CACHE;
        } else {
          process.env.ATLAS_WALKTHROUGH_FILE_CACHE = original;
        }
        vi.resetModules();
      }
    });
  });

  describe('map-reduce path (≥20 files)', () => {
    function buildLargeDiff(count) {
      return Array.from({ length: count }, (_, index) => {
        const fileIndex = index + 1;
        return `diff --git a/src/area${fileIndex % 4}/file${fileIndex}.ts b/src/area${fileIndex % 4}/file${fileIndex}.ts
index 111..222 100644
--- a/src/area${fileIndex % 4}/file${fileIndex}.ts
+++ b/src/area${fileIndex % 4}/file${fileIndex}.ts
@@ -1,3 +1,4 @@
 export const v${fileIndex} = ${fileIndex};
+export const w${fileIndex} = ${fileIndex + 1};
`;
      }).join('');
    }

    function buildLargeFileSummaries(count) {
      return Array.from({ length: count }, (_, index) => {
        const fileIndex = index + 1;
        return {
          path: `src/area${fileIndex % 4}/file${fileIndex}.ts`,
          additions: 1,
          deletions: 0,
        };
      });
    }

    function buildAssetHeavyFileSummaries({ codeCount = 10, assetCount = 20, deletedCount = 10 } = {}) {
      const code = buildLargeFileSummaries(codeCount);
      const assets = Array.from({ length: assetCount }, (_, index) => ({
        path: `Assets/Art/Icon${index + 1}.png.meta`,
        additions: 8,
        deletions: 0,
        status: 'A',
      }));
      const deleted = Array.from({ length: deletedCount }, (_, index) => ({
        path: `Assets/Obsolete/Old${index + 1}.asset`,
        additions: 0,
        deletions: 400,
        status: 'D',
      }));
      return [...code, ...assets, ...deleted];
    }

    it('runs multiple parallel cluster calls instead of a single pass', async () => {
      const fileSummaries = buildLargeFileSummaries(40);
      const diff = buildLargeDiff(40);
      const providerCall = vi.fn().mockImplementation(async ({ prompt }) => {
        // Each cluster prompt mentions exactly one cluster's files. Pick a
        // representative path from the prompt and respond with a one-group
        // walkthrough covering the cluster's files.
        const promptFiles = (prompt.match(/^- (\S+) \(\+\d+ -\d+\)/gm) || [])
          .map((line) => line.match(/^- (\S+)/)[1]);
        return {
          text: JSON.stringify({
            changeGroups: [{
              label: 'Cluster',
              description: 'Generated for this cluster.',
              risk: 'low',
              files: promptFiles.map((path) => ({
                path,
                additions: 1,
                deletions: 0,
                description: 'Updated.',
              })),
            }],
          }),
        };
      });

      const result = await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff,
        fileSummaries,
        providerType: 'anthropic',
        providerCall,
      });

      // Map-reduce should fire multiple cluster calls (>1).
      expect(providerCall.mock.calls.length).toBeGreaterThan(1);
      // Every file from the manifest must end up in the saved walkthrough.
      const allFiles = result.flatMap((group) => group.files.map((f) => f.path));
      expect(new Set(allFiles).size).toBe(40);
    });

    it('keeps deleted and asset files out of LLM prompts and covers them deterministically', async () => {
      const fileSummaries = buildAssetHeavyFileSummaries({ codeCount: 10, assetCount: 20, deletedCount: 10 });
      const diff = `${buildLargeDiff(10)}
diff --git a/Assets/Art/Icon1.png.meta b/Assets/Art/Icon1.png.meta
index 111..222 100644
--- a/Assets/Art/Icon1.png.meta
+++ b/Assets/Art/Icon1.png.meta
@@ -1,2 +1,3 @@
 fileFormatVersion: 2
+guid: new
diff --git a/Assets/Obsolete/Old1.asset b/Assets/Obsolete/Old1.asset
deleted file mode 100644
index 111..000
--- a/Assets/Obsolete/Old1.asset
+++ /dev/null
@@ -1,3 +0,0 @@
-large deleted asset body
-large deleted asset body
-large deleted asset body
`;
      const providerCall = vi.fn().mockImplementation(async ({ prompt }) => {
        expect(prompt).not.toContain('Assets/Art/Icon1.png.meta');
        expect(prompt).not.toContain('Assets/Obsolete/Old1.asset');
        const promptFiles = (prompt.match(/^- (\S+) \(\+\d+ -\d+\)/gm) || [])
          .map((line) => line.match(/^- (\S+)/)[1]);
        return {
          text: JSON.stringify({
            changeGroups: [{
              label: 'Code changes',
              description: 'Narrates code-bearing files.',
              risk: 'low',
              files: promptFiles.map((path) => ({
                path,
                additions: 1,
                deletions: 0,
                description: 'Updated.',
              })),
            }],
          }),
        };
      });

      const result = await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff,
        fileSummaries,
        providerType: 'anthropic',
        providerCall,
      });

      // After deterministic holdout only 10 code files need narration, so the
      // large total manifest should use the single-pass path.
      expect(providerCall).toHaveBeenCalledTimes(1);
      const allFiles = result.flatMap((group) => group.files.map((file) => file.path));
      expect(new Set(allFiles).size).toBe(40);
      expect(result.some((group) => group.label === 'Assets and generated files')).toBe(true);
      expect(result.some((group) => group.label === 'Deleted files')).toBe(true);
    });

    it('places deterministic asset and deleted groups after LLM-authored steps', async () => {
      const fileSummaries = buildAssetHeavyFileSummaries({ codeCount: 2, assetCount: 2, deletedCount: 2 });
      const diff = buildLargeDiff(2);
      const providerCall = vi.fn().mockResolvedValue({
        text: JSON.stringify({
          changeGroups: [{
            label: 'Code walkthrough',
            description: 'Narrates code first.',
            risk: 'low',
            files: [
              { path: 'src/area1/file1.ts', additions: 1, deletions: 0, description: 'Updated.' },
              { path: 'src/area2/file2.ts', additions: 1, deletions: 0, description: 'Updated.' },
            ],
          }],
        }),
      });

      const result = await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff,
        fileSummaries,
        providerType: 'anthropic',
        providerCall,
      });

      expect(result.map((group) => group.label)).toEqual([
        'Code walkthrough',
        'Assets and generated files',
        'Deleted files',
      ]);
    });

    it('skips LLM calls entirely when a large walkthrough contains only deterministic files', async () => {
      const fileSummaries = buildAssetHeavyFileSummaries({ codeCount: 0, assetCount: 25, deletedCount: 15 });
      const providerCall = vi.fn();

      const result = await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff: '',
        fileSummaries,
        providerType: 'anthropic',
        providerCall,
      });

      expect(providerCall).not.toHaveBeenCalled();
      const allFiles = result.flatMap((group) => group.files.map((file) => file.path));
      expect(new Set(allFiles).size).toBe(40);
      expect(saveWalkthroughMock).toHaveBeenCalledTimes(1);
    });

    it('runs a synthesis pass to consolidate fragment groups when there are too many', async () => {
      // 40 files split into many isolated clusters → fragmentGroups well
      // above SYNTHESIS_TARGET_MAX_GROUPS (7). Synthesis must fire and the
      // returned walkthrough must have <= 7 groups.
      const fileSummaries = buildLargeFileSummaries(40);
      const diff = buildLargeDiff(40);

      let synthesisCalled = false;
      const providerCall = vi.fn().mockImplementation(async ({ prompt }) => {
        const promptFiles = (prompt.match(/^- (\S+) \(\+\d+ -\d+\)/gm) || [])
          .map((line) => line.match(/^- (\S+)/)[1]);
        if (prompt.includes('Per-cluster fragments to consolidate')) {
          // Synthesis call: produce 4 thematic groups partitioning all files.
          synthesisCalled = true;
          const quarters = [
            promptFiles.slice(0, 10),
            promptFiles.slice(10, 20),
            promptFiles.slice(20, 30),
            promptFiles.slice(30, 40),
          ];
          return {
            text: JSON.stringify({
              changeGroups: quarters.map((paths, i) => ({
                label: `Theme ${i + 1}`,
                description: 'Consolidated.',
                risk: 'low',
                files: paths.map((path) => ({ path, additions: 1, deletions: 0, description: 'Updated.' })),
              })),
            }),
          };
        }
        // Cluster call: produce one group covering the cluster files.
        return {
          text: JSON.stringify({
            changeGroups: [{
              label: 'Cluster',
              description: 'Generated for this cluster.',
              risk: 'low',
              files: promptFiles.map((path) => ({ path, additions: 1, deletions: 0, description: 'Updated.' })),
            }],
          }),
        };
      });

      const result = await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff,
        fileSummaries,
        providerType: 'anthropic',
        providerCall,
      });

      expect(synthesisCalled).toBe(true);
      expect(result.length).toBeLessThanOrEqual(7);
      const allFiles = result.flatMap((group) => group.files.map((f) => f.path));
      expect(new Set(allFiles).size).toBe(40);
    });

    it('skips synthesis when fragment count is already at target', async () => {
      // Force a small number of clusters via maxClusters override. With 5
      // clusters, fragment count == 5 <= 7, so synthesis should NOT fire.
      const original = process.env.ATLAS_WALKTHROUGH_MAP_REDUCE_MAX_CLUSTERS;
      process.env.ATLAS_WALKTHROUGH_MAP_REDUCE_MAX_CLUSTERS = '5';
      vi.resetModules();
      const { generateWalkthrough: gen } = await import('../walkthroughGeneration.js');

      try {
        const fileSummaries = buildLargeFileSummaries(40);
        const diff = buildLargeDiff(40);
        let synthesisCalled = false;
        const providerCall = vi.fn().mockImplementation(async ({ prompt }) => {
          if (prompt.includes('Per-cluster fragments to consolidate')) {
            synthesisCalled = true;
          }
          const promptFiles = (prompt.match(/^- (\S+) \(\+\d+ -\d+\)/gm) || [])
            .map((line) => line.match(/^- (\S+)/)[1]);
          return {
            text: JSON.stringify({
              changeGroups: [{
                label: 'Cluster',
                description: 'Generated for this cluster.',
                risk: 'low',
                files: promptFiles.map((path) => ({ path, additions: 1, deletions: 0, description: 'Updated.' })),
              }],
            }),
          };
        });

        await gen({
          projectId: 'proj-1',
          baseSha: 'base',
          headSha: 'head',
          diff,
          fileSummaries,
          providerType: 'anthropic',
          providerCall,
        });

        expect(synthesisCalled).toBe(false);
      } finally {
        if (original === undefined) {
          delete process.env.ATLAS_WALKTHROUGH_MAP_REDUCE_MAX_CLUSTERS;
        } else {
          process.env.ATLAS_WALKTHROUGH_MAP_REDUCE_MAX_CLUSTERS = original;
        }
        vi.resetModules();
      }
    });

    it('falls back to deterministic groups when every cluster call fails', async () => {
      const fileSummaries = buildLargeFileSummaries(40);
      const diff = buildLargeDiff(40);
      const providerCall = vi.fn().mockRejectedValue(new Error('all clusters down'));

      const result = await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff,
        fileSummaries,
        providerType: 'anthropic',
        providerCall,
      });

      expect(saveWalkthroughMock).toHaveBeenCalledTimes(1);
      const persisted = saveWalkthroughMock.mock.calls[0][0];
      const persistedFiles = persisted.changeGroups.flatMap((g) => g.files.map((f) => f.path));
      // Deterministic fallback should still cover every file.
      expect(new Set(persistedFiles).size).toBe(40);
      expect(Array.isArray(result)).toBe(true);
    });

    it('keeps successful cluster output when only some clusters fail', async () => {
      const fileSummaries = buildLargeFileSummaries(40);
      const diff = buildLargeDiff(40);
      let callIndex = 0;
      const providerCall = vi.fn().mockImplementation(async ({ prompt }) => {
        callIndex += 1;
        // Fail every other cluster call.
        if (callIndex % 2 === 0) throw new Error('cluster failed');
        const promptFiles = (prompt.match(/^- (\S+) \(\+\d+ -\d+\)/gm) || [])
          .map((line) => line.match(/^- (\S+)/)[1]);
        return {
          text: JSON.stringify({
            changeGroups: [{
              label: 'Survivor',
              description: 'Cluster survived.',
              risk: 'low',
              files: promptFiles.map((path) => ({
                path, additions: 1, deletions: 0, description: 'Updated.',
              })),
            }],
          }),
        };
      });

      const result = await generateWalkthrough({
        projectId: 'proj-1',
        baseSha: 'base',
        headSha: 'head',
        diff,
        fileSummaries,
        providerType: 'anthropic',
        providerCall,
      });

      // Coverage augmentation should backfill files from failed clusters.
      const allFiles = result.flatMap((group) => group.files.map((f) => f.path));
      expect(new Set(allFiles).size).toBe(40);
      expect(saveWalkthroughMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('buildWalkthroughPrompt', () => {
  it('does NOT include a recommendations section in the prompt', () => {
    const prompt = buildWalkthroughPrompt({ diff: SAMPLE_DIFF });
    // Walkthrough is structural narration only — no findings reasoning.
    expect(prompt.toLowerCase()).not.toContain('recommendations');
    expect(prompt.toLowerCase()).not.toContain('candidatefindings');
  });

  it('includes the changeGroups schema and the diff', () => {
    const prompt = buildWalkthroughPrompt({ diff: SAMPLE_DIFF });
    expect(prompt).toContain('changeGroups');
    expect(prompt).toContain('src/auth.js');
  });

  it('includes an authoritative file manifest for full coverage', () => {
    const prompt = buildWalkthroughPrompt({ diff: TWO_FILE_DIFF });
    expect(prompt).toContain('Changed file manifest');
    expect(prompt).toContain('- src/auth.js (+1 -0)');
    expect(prompt).toContain('- frontend/src/App.tsx (+1 -0)');
    expect(prompt).toContain('include EVERY file');
  });

  it('labels deleted and renamed files in supplied manifests', () => {
    const prompt = buildWalkthroughPrompt({
      diff: '',
      fileSummaries: [
        { path: 'src/old.ts', additions: 0, deletions: 20, status: 'D' },
        { path: 'src/new-name.ts', additions: 2, deletions: 1, status: 'R', oldPath: 'src/old-name.ts' },
      ],
    });
    expect(prompt).toContain('- src/old.ts [deleted] (+0 -20)');
    expect(prompt).toContain('- src/new-name.ts [renamed from src/old-name.ts] (+2 -1)');
  });

  it('summarizes huge manifests instead of putting every path in the prompt', () => {
    const prompt = buildWalkthroughPrompt({
      diff: SAMPLE_DIFF,
      fileSummaries: buildFileSummaries(300),
    });
    expect(prompt).toContain('Changed file summary');
    expect(prompt).toContain('Total changed files: 300');
    expect(prompt).toContain('Representative changed files');
    expect(prompt).not.toContain('- src/file1.js (+1 -0)');
    expect(prompt.length).toBeLessThan(30000);
  });

  it('produces a substantially shorter prompt than the combined review prompt', () => {
    // The plan target is ~30% of combined-prompt token count. We can't easily
    // call the real combined prompt builder here without a heavy stub, so
    // sanity-check absolute compactness instead. Should be < ~3000 chars
    // for an empty-ish diff.
    const prompt = buildWalkthroughPrompt({ diff: SAMPLE_DIFF });
    expect(prompt.length).toBeLessThan(3000);
  });
});
