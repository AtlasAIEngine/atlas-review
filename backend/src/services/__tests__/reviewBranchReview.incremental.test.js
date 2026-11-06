import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const branchReviewState = {
  current: null,
};

const providerCalls = [];
const providerCandidate = {
  id: 'provider-test',
  type: 'openai',
  model: 'gpt-4.1-mini',
};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function applyBranchReviewPatch(target, payload) {
  const fieldMap = {
    review_status: 'reviewStatus',
    review_risk_level: 'reviewRiskLevel',
    review_summary: 'reviewSummary',
    review_error: 'reviewError',
    review_base_branch: 'reviewBaseBranch',
    review_merge_base_sha: 'reviewMergeBaseSha',
    review_head_sha: 'reviewHeadSha',
    review_json: 'reviewJson',
    reviewed_at: 'reviewedAt',
    merge_base_sha: 'mergeBaseSha',
    head_sha: 'headSha',
    base_branch: 'baseBranch',
    file_count: 'fileCount',
    total_additions: 'totalAdditions',
    total_deletions: 'totalDeletions',
    commit_count: 'commitCount',
    first_commit_at: 'firstCommitAt',
    last_commit_at: 'lastCommitAt',
    is_current: 'isCurrent',
  };

  for (const [key, value] of Object.entries(payload || {})) {
    const mappedKey = fieldMap[key] || key;
    if (mappedKey === 'reviewJson' && typeof value === 'string') {
      target.reviewJson = JSON.parse(value);
      continue;
    }
    target[mappedKey] = value;
  }
}

async function loadReviewModules() {
  vi.resetModules();

  vi.doMock('../providerService.js', () => ({
    default: {
      getContextActiveProvider: vi.fn(async () => null),
      getReviewProviderCandidatesWithKeys: vi.fn(async () => [providerCandidate]),
      getActiveProviderWithKey: vi.fn(async () => null),
    },
  }));

  vi.doMock('../branchReviewService.js', () => ({
    default: {
      getById: vi.fn(async () => clone(branchReviewState.current)),
      updateReview: vi.fn(async (_id, payload) => {
        applyBranchReviewPatch(branchReviewState.current, payload);
        return clone(branchReviewState.current);
      }),
      getReviewFileCacheByKeys: vi.fn(async () => []),
      upsertReviewFileCacheEntries: vi.fn(async () => []),
    },
  }));

  vi.doMock('../usageService.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      default: {
        ...actual.default,
        recordUsage: vi.fn(async () => {}),
      },
    };
  });

  vi.doMock('../trustAnalyticsFactService.js', () => ({
    default: {
      syncReviewFacts: vi.fn(async () => {}),
    },
  }));

  vi.doMock('../review/reviewModelConfig.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      getGlobalReviewModelConfig: vi.fn(async () => ({
        strategy: 'smart',
        customModels: {},
        adaptive: {},
        rollout: { mode: 'all', allowlist: [], gate: { status: 'pass', source: 'default', reasonCodes: [] } },
      })),
    };
  });

  vi.doMock('../review/reviewPromptContext.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      collectPromptContextSignals: vi.fn(async (_projectPath, context = {}) => ({
        commitMessages: Array.isArray(context.rangeCommits)
          ? context.rangeCommits.map((commit) => commit.message).filter(Boolean)
          : [],
        verificationStatus: context.verificationStatus || { summary: 'No checks recorded.', lines: [] },
        priorFindingHints: [],
        fileRiskContext: [],
        claudeConventions: [],
        projectMetadata: null,
        dismissedPatterns: [],
        queuedCommitShas: context.queuedCommitShas || [],
      })),
      resolveBranchReviewVerificationStatus: vi.fn(async () => ({
        summary: 'No checks recorded.',
        lines: [],
      })),
    };
  });

  vi.doMock('../review/reviewIgnorePatterns.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      buildEffectiveScope: vi.fn(async (scope) => ({
        requestedScope: {
          includePatterns: Array.isArray(scope?.includePatterns) ? scope.includePatterns : [],
          excludePatterns: Array.isArray(scope?.excludePatterns) ? scope.excludePatterns : [],
          applyGlobalIgnorePatterns: scope?.applyGlobalIgnorePatterns !== false,
        },
        effectiveScope: null,
        globalExcludePatterns: [],
      })),
      getGlobalReviewIgnorePatterns: vi.fn(async () => []),
    };
  });

  vi.doMock('../review/reviewProjectProfileService.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      resolveReviewProjectProfile: vi.fn(async () => null),
    };
  });

  vi.doMock('../review/reviewProviderExecution.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      getExecutionModeOrder: vi.fn(async () => ['api']),
      callProviderForReviewWithFailover: vi.fn(async (_state, prompt) => {
        providerCalls.push(prompt);
        const summary = providerCalls.length === 1 ? 'First branch review summary.' : 'Incremental branch review summary.';
        const file = providerCalls.length === 1 ? 'src/first.js' : 'src/second.js';
        return {
          text: JSON.stringify({
            summary,
            riskLevel: 'medium',
            changeGroups: [],
            recommendations: [
              {
                type: 'issue',
                severity: 'medium',
                file,
                title: `Check ${path.basename(file)}`,
                description: `Investigate ${file}`,
              },
            ],
          }),
          tokensUsed: { input: 10, output: 20 },
          providerData: providerCandidate,
          modelUsed: providerCandidate.model,
        };
      }),
    };
  });

  vi.doMock('../review/reviewVerifier.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      runBoundedHighRiskVerifierPass: vi.fn(async (review) => review),
    };
  });

  vi.doMock('../review/reviewCorroborationIntegration.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      applyCorroborationPolicyToReview: vi.fn((review) => review),
      applyOutcomeSuppressionPolicyToReview: vi.fn(async (review) => review),
      normalizePrecisionIssueCounters: vi.fn((review) => review),
      applyEvidencePolicyToReview: vi.fn((review, options = {}) => ({
        review,
        policy: options.policy || 'disabled',
      })),
      normalizeEvidencePolicyForReview: vi.fn(() => 'disabled'),
    };
  });

  const [{ default: reviewService }, { default: gitService }, { default: usageService }] = await Promise.all([
    import('../reviewService.js'),
    import('../gitService.js'),
    import('../usageService.js'),
  ]);

  return { reviewService, gitService, usageService };
}

async function runGit(cwd, ...args) {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function createRepoFixture() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-branch-review-incremental-'));
  await runGit(repoDir, 'init');
  await runGit(repoDir, 'config', 'user.name', 'Atlas Test');
  await runGit(repoDir, 'config', 'user.email', 'atlas-test@example.com');
  await runGit(repoDir, 'checkout', '-b', 'main');
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoDir, 'src', 'base.js'), "export const base = 'main';\n", 'utf8');
  await runGit(repoDir, 'add', '.');
  await runGit(repoDir, 'commit', '-m', 'chore: initial main');
  return repoDir;
}

async function computeBranchStats(repoDir, baseBranch = 'main') {
  const { default: gitService } = await import('../gitService.js');
  const headSha = await gitOutput(repoDir, 'rev-parse', 'HEAD');
  const mergeBaseSha = await gitOutput(repoDir, 'merge-base', baseBranch, headSha);
  const diffStats = await gitService.getThreeDotDiffStats(repoDir, mergeBaseSha, headSha);
  return {
    headSha,
    mergeBaseSha,
    fileCount: diffStats.fileCount,
    totalAdditions: diffStats.totalAdditions,
    totalDeletions: diffStats.totalDeletions,
    commitCount: diffStats.commitCount,
    firstCommitAt: diffStats.firstCommitAt,
    lastCommitAt: diffStats.lastCommitAt,
  };
}

describe('reviewBranchReview incremental reruns', () => {
  let repoDir;
  let reviewService;
  let usageService;

  beforeEach(async () => {
    providerCalls.length = 0;
    reviewService = null;
    usageService = null;
    repoDir = await createRepoFixture();
  });

  afterEach(async () => {
    branchReviewState.current = null;
    if (repoDir) {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('does a full first review and then reruns on only unreviewed commits', async () => {
    ({ reviewService, usageService } = await loadReviewModules());
    await runGit(repoDir, 'checkout', '-b', 'feature/incremental');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'a';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add first branch file');

    branchReviewState.current = {
      id: 'br-test-1',
      projectId: 'project-1',
      displayId: 'BR-001',
      branchName: 'feature/incremental',
      baseBranch: 'main',
      status: 'active',
      isCurrent: true,
      reviewStatus: 'none',
      reviewRiskLevel: null,
      reviewSummary: null,
      reviewError: null,
      reviewBaseBranch: null,
      reviewMergeBaseSha: null,
      reviewHeadSha: null,
      reviewedAt: null,
      reviewJson: null,
      ...(await computeBranchStats(repoDir)),
    };

    const firstResult = await reviewService.reviewBranchReview(repoDir, branchReviewState.current.id);
    expect(firstResult.stats.diffScopeMode).toBe('full');
    expect(firstResult.stats.deltaFallbackReason).toBe('no_prior_completed_review');
    expect(branchReviewState.current.reviewStatus).toBe('reviewed');
    expect(branchReviewState.current.reviewHeadSha).toBe(branchReviewState.current.headSha);
    expect(branchReviewState.current.reviewMergeBaseSha).toBe(branchReviewState.current.mergeBaseSha);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toContain('src/first.js');
    expect(providerCalls[0]).not.toContain('src/second.js');
    expect(providerCalls[0]).not.toContain('Incremental review note: this rerun covers only unreviewed commits');
    expect(branchReviewState.current.reviewJson.estimatedCost).toBeGreaterThan(0);
    expect(branchReviewState.current.reviewJson.costSource).toBe('fallback_pricing');
    expect(branchReviewState.current.reviewJson.costIsApproximate).toBe(true);
    expect(usageService.recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      reviewType: 'branch_review',
      reviewId: branchReviewState.current.id,
      changesetId: null,
      model: providerCandidate.model,
      inputTokens: 10,
      outputTokens: 20,
    }));

    const firstReviewedHead = branchReviewState.current.reviewHeadSha;

    await fs.writeFile(path.join(repoDir, 'src', 'second.js'), "export const second = 'b';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/second.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add second branch file');

    Object.assign(branchReviewState.current, await computeBranchStats(repoDir), {
      reviewStatus: 'queued',
    });

    const secondResult = await reviewService.reviewBranchReview(repoDir, branchReviewState.current.id);
    expect(secondResult.stats.diffScopeMode).toBe('delta');
    expect(secondResult.stats.deltaFallbackReason).toBeNull();
    expect(secondResult.stats.diffBaseSha).toBe(firstReviewedHead);
    expect(secondResult.stats.diffHeadSha).toBe(branchReviewState.current.headSha);
    expect(secondResult.stats.diffScopeCommitCount).toBe(1);
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[1]).toContain('Incremental review note: this rerun covers only unreviewed commits');
    expect(providerCalls[1]).toContain('Previous review summary: First branch review summary.');
    expect(providerCalls[1]).toContain('Previous top findings: [medium] src/first.js: Check first.js.');
    expect(providerCalls[1]).toContain('src/second.js');
    expect(providerCalls[1]).not.toContain('diff --git a/src/first.js b/src/first.js');
    expect(branchReviewState.current.reviewStatus).toBe('reviewed');
    expect(branchReviewState.current.reviewJson.stats.diffScopeMode).toBe('delta');
    expect(branchReviewState.current.reviewJson.stats.diffScopeCommitCount).toBe(1);
    expect(branchReviewState.current.reviewJson.estimatedCost).toBeGreaterThan(0);
    expect(branchReviewState.current.reviewJson.costSource).toBe('fallback_pricing');
    expect(branchReviewState.current.reviewJson.costIsApproximate).toBe(true);
    expect(usageService.recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      reviewType: 'branch_review',
      reviewId: branchReviewState.current.id,
    }));
  });

  it('honors reviewMode=full on a rerun even after a completed baseline exists', async () => {
    ({ reviewService } = await loadReviewModules());
    await runGit(repoDir, 'checkout', '-b', 'feature/full-rerun');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'a';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add first branch file');

    branchReviewState.current = {
      id: 'br-test-2',
      projectId: 'project-1',
      displayId: 'BR-002',
      branchName: 'feature/full-rerun',
      baseBranch: 'main',
      status: 'active',
      isCurrent: true,
      reviewStatus: 'none',
      reviewJson: null,
      ...(await computeBranchStats(repoDir)),
    };

    await reviewService.reviewBranchReview(repoDir, branchReviewState.current.id);

    await fs.writeFile(path.join(repoDir, 'src', 'second.js'), "export const second = 'b';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/second.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add second branch file');

    Object.assign(branchReviewState.current, await computeBranchStats(repoDir), {
      reviewStatus: 'queued',
    });

    const rerun = await reviewService.reviewBranchReview(repoDir, branchReviewState.current.id, {
      reviewMode: 'full',
    });

    expect(rerun.stats.diffScopeMode).toBe('full');
    expect(rerun.stats.deltaFallbackReason).toBe('forced_full_review');
    expect(providerCalls.at(-1)).toContain('src/first.js');
    expect(providerCalls.at(-1)).toContain('src/second.js');
    expect(providerCalls.at(-1)).not.toContain('Incremental review note: this rerun covers only unreviewed commits');
  });

  it('reuses the persisted review result when a forced auto rerun has no unreviewed commits', async () => {
    ({ reviewService } = await loadReviewModules());
    await runGit(repoDir, 'checkout', '-b', 'feature/no-unreviewed');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'a';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add first branch file');

    branchReviewState.current = {
      id: 'br-test-3',
      projectId: 'project-1',
      displayId: 'BR-003',
      branchName: 'feature/no-unreviewed',
      baseBranch: 'main',
      status: 'active',
      isCurrent: true,
      reviewStatus: 'none',
      reviewJson: null,
      ...(await computeBranchStats(repoDir)),
    };

    const firstResult = await reviewService.reviewBranchReview(repoDir, branchReviewState.current.id, { force: true });
    providerCalls.length = 0;
    const firstReviewedAt = branchReviewState.current.reviewedAt;

    const secondResult = await reviewService.reviewBranchReview(repoDir, branchReviewState.current.id, { force: true });

    expect(providerCalls).toHaveLength(0);
    expect(secondResult.summary).toBe(firstResult.summary);
    expect(secondResult.riskLevel).toBe(firstResult.riskLevel);
    expect(secondResult.stats.diffScopeMode).toBe('delta');
    expect(secondResult.stats.diffScopeCommitCount).toBe(0);
    expect(secondResult.stats.deltaFallbackReason).toBe('no_unreviewed_commits');
    expect(secondResult.stats.incrementalSkipped).toBe(true);
    expect(secondResult.stats.incrementalSkippedReason).toBe('no_unreviewed_commits');
    expect(branchReviewState.current.reviewStatus).toBe('reviewed');
    expect(branchReviewState.current.reviewError).toBeNull();
    expect(branchReviewState.current.reviewJson.stats.incrementalSkipped).toBe(true);
    expect(branchReviewState.current.reviewedAt).not.toBe(firstReviewedAt);
    expect(secondResult.reviewedAt).toBe(branchReviewState.current.reviewedAt);
    expect(branchReviewState.current.reviewJson.reviewedAt).toBe(branchReviewState.current.reviewedAt);
  });
});
