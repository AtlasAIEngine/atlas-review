import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

vi.mock('../trustAnalyticsFactService.js', () => ({
  default: {
    syncReviewFacts: vi.fn().mockResolvedValue(undefined),
  },
}));

import reviewService from '../reviewService.js';
import providerService from '../providerService.js';
import branchReviewService from '../branchReviewService.js';
import gitService from '../gitService.js';
import usageService from '../usageService.js';
import * as reviewPromptContextModule from '../review/reviewPromptContext.js';
import * as reviewModelConfigModule from '../review/reviewModelConfig.js';
import * as reviewProviderExecutionModule from '../review/reviewProviderExecution.js';
import * as reviewIgnorePatternsModule from '../review/reviewIgnorePatterns.js';

const execFileAsync = promisify(execFile);

async function run(cmd, args, options = {}) {
  const { cwd } = options;
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: stdout?.toString().trim() || '',
    stderr: stderr?.toString().trim() || '',
  };
}

async function git(repoPath, ...args) {
  return run('git', args, { cwd: repoPath });
}

function createProviderResponse(summary = 'review completed') {
  return {
    text: JSON.stringify({
      summary,
      riskLevel: 'low',
      changeGroups: [],
      recommendations: [],
      stats: {
        filesAnalyzed: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        estimatedComplexity: 'simple',
      },
    }),
    tokensUsed: { input: 10, output: 5 },
    modelUsed: 'gpt-test',
  };
}

function applyBranchReviewUpdates(branchReview, updates) {
  const fieldMap = {
    review_status: 'reviewStatus',
    review_risk_level: 'reviewRiskLevel',
    review_summary: 'reviewSummary',
    review_json: 'reviewJson',
    review_error: 'reviewError',
    review_base_branch: 'reviewBaseBranch',
    review_merge_base_sha: 'reviewMergeBaseSha',
    review_head_sha: 'reviewHeadSha',
    reviewed_at: 'reviewedAt',
    head_sha: 'headSha',
    merge_base_sha: 'mergeBaseSha',
    file_count: 'fileCount',
    total_additions: 'totalAdditions',
    total_deletions: 'totalDeletions',
    commit_count: 'commitCount',
  };

  for (const [key, value] of Object.entries(updates || {})) {
    const targetKey = fieldMap[key] || key;
    branchReview[targetKey] = targetKey === 'reviewJson' && typeof value === 'string'
      ? JSON.parse(value)
      : value;
  }

  return { ...branchReview };
}

async function createFixtureRepo(rootDir) {
  const repoDir = path.join(rootDir, 'repo');

  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.mkdir(path.join(repoDir, '.atlas'), { recursive: true });
  await run('git', ['init', repoDir]);
  await git(repoDir, 'config', 'user.name', 'Review Tester');
  await git(repoDir, 'config', 'user.email', 'review-tester@example.com');
  await git(repoDir, 'checkout', '-b', 'main');

  await fs.writeFile(path.join(repoDir, 'src', 'base.js'), "export const base = 'main';\n", 'utf8');
  await fs.writeFile(
    path.join(repoDir, '.atlas', 'review-policy.json'),
    JSON.stringify({
      version: 1,
      promptAppend: ['Trusted main review guidance.'],
      paths: [
        {
          glob: 'src/**/*.js',
          fileClass: 'deep',
          mustCheckRules: ['missing_input_validation'],
        },
      ],
    }, null, 2),
    'utf8'
  );
  await git(repoDir, 'add', 'src/base.js');
  await git(repoDir, 'add', '.atlas/review-policy.json');
  await git(repoDir, 'commit', '-m', 'chore: initial main');

  const mergeBaseSha = (await git(repoDir, 'rev-parse', 'HEAD')).stdout;

  await git(repoDir, 'checkout', '-b', 'feature/incremental-review');
  await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'first';\n", 'utf8');
  await git(repoDir, 'add', 'src/first.js');
  await git(repoDir, 'commit', '-m', 'feat: add first file');

  const firstHeadSha = (await git(repoDir, 'rev-parse', 'HEAD')).stdout;

  return { repoDir, mergeBaseSha, firstHeadSha };
}

describe('branch review incremental execution', () => {
  let testRoot;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-branch-review-exec-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it('reviews the full branch once, then narrows subsequent reruns to only unreviewed commits', async () => {
    const { repoDir, mergeBaseSha, firstHeadSha } = await createFixtureRepo(testRoot);
    await fs.writeFile(
      path.join(repoDir, '.atlas', 'review-policy.json'),
      JSON.stringify({
        version: 1,
        promptAppend: ['Malicious feature guidance.'],
      }, null, 2),
      'utf8'
    );
    await git(repoDir, 'add', '.atlas/review-policy.json');
    await git(repoDir, 'commit', '-m', 'chore: mutate review policy on feature branch');
    const maliciousHeadSha = (await git(repoDir, 'rev-parse', 'HEAD')).stdout;
    const providerPrompts = [];
    const branchReview = {
      id: 'br-incremental',
      projectId: 'project-1',
      branchName: 'feature/incremental-review',
      baseBranch: 'main',
      mergeBaseSha,
      headSha: maliciousHeadSha,
      fileCount: 2,
      totalAdditions: 14,
      totalDeletions: 0,
      commitCount: 2,
      reviewStatus: 'none',
      reviewRiskLevel: null,
      reviewSummary: null,
      reviewError: null,
      reviewBaseBranch: null,
      reviewMergeBaseSha: null,
      reviewHeadSha: null,
      reviewedAt: null,
      reviewJson: null,
    };

    vi.spyOn(providerService, 'getContextActiveProvider').mockResolvedValue(null);
    vi.spyOn(providerService, 'getReviewProviderCandidatesWithKeys').mockResolvedValue([
      {
        provider: { id: 'provider-1', type: 'openai', model: 'gpt-test' },
        apiKey: 'test-key',
      },
    ]);
    vi.spyOn(providerService, 'getActiveProviderWithKey').mockResolvedValue(null);
    vi.spyOn(branchReviewService, 'getById').mockImplementation(async () => ({ ...branchReview }));
    vi.spyOn(branchReviewService, 'updateReview').mockImplementation(async (_id, updates) => {
      return applyBranchReviewUpdates(branchReview, updates);
    });
    vi.spyOn(usageService, 'recordUsage').mockResolvedValue(undefined);
    vi.spyOn(reviewPromptContextModule, 'collectPromptContextSignals').mockResolvedValue({
      commitMessages: [],
      verificationStatus: null,
      priorFindingHints: [],
      fileRiskContext: [],
      claudeConventions: [],
      projectMetadata: null,
      dismissedPatterns: [],
      queuedCommitShas: [],
    });
    vi.spyOn(reviewPromptContextModule, 'resolveBranchReviewVerificationStatus').mockResolvedValue(null);
    vi.spyOn(reviewIgnorePatternsModule, 'getGlobalReviewIgnorePatterns').mockResolvedValue([]);
    vi.spyOn(reviewIgnorePatternsModule, 'buildEffectiveScope').mockResolvedValue({
      requestedScope: {
        includePatterns: [],
        excludePatterns: [],
        applyGlobalIgnorePatterns: true,
        hasExplicitScope: false,
      },
      effectiveScope: null,
      globalExcludePatterns: [],
    });
    vi.spyOn(reviewModelConfigModule, 'getGlobalReviewModelConfig').mockResolvedValue({
      strategy: 'smart',
      customModels: {},
      adaptive: {},
      rollout: {},
    });
    vi.spyOn(reviewProviderExecutionModule, 'getExecutionModeOrder').mockResolvedValue([]);
    vi.spyOn(reviewProviderExecutionModule, 'callProviderForReviewWithFailover').mockImplementation(
      async (_providerState, prompt) => {
        providerPrompts.push(prompt);
        return createProviderResponse(`review ${providerPrompts.length}`);
      }
    );

    const firstResult = await reviewService.reviewBranchReview(repoDir, branchReview.id);
    expect(firstResult.summary).toBe('review 1');
    expect(providerPrompts).toHaveLength(1);
    expect(providerPrompts[0]).toContain('src/first.js');
    expect(providerPrompts[0]).toContain('Policy guidance:');
    expect(providerPrompts[0]).toContain('Trusted main review guidance.');
    expect(providerPrompts[0]).not.toContain('Incremental review note');
    expect(branchReview.reviewJson?.stats?.diffScopeMode).toBe('full');
    expect(branchReview.reviewJson?.stats?.diffBaseSha).toBe(mergeBaseSha);
    expect(branchReview.reviewHeadSha).toBe(maliciousHeadSha);
    expect(branchReview.reviewMergeBaseSha).toBe(mergeBaseSha);
    expect(branchReview.reviewJson?.stats?.reviewPolicy?.sourcePath).toBe('.atlas/review-policy.json');
    expect(branchReview.reviewJson?.stats?.reviewPolicy?.trustedRef).toContain('main');

    await fs.writeFile(path.join(repoDir, 'src', 'second.js'), "export const second = 'second';\n", 'utf8');
    await git(repoDir, 'add', 'src/second.js');
    await git(repoDir, 'commit', '-m', 'feat: add second file');

    const secondHeadSha = (await git(repoDir, 'rev-parse', 'HEAD')).stdout;
    const secondDiffStats = await gitService.getThreeDotDiffStats(repoDir, mergeBaseSha, secondHeadSha);
    const secondRangeCommits = await gitService.getCommitsBetween(repoDir, mergeBaseSha, secondHeadSha);

    branchReview.headSha = secondHeadSha;
    branchReview.fileCount = secondDiffStats.fileCount;
    branchReview.totalAdditions = secondDiffStats.totalAdditions;
    branchReview.totalDeletions = secondDiffStats.totalDeletions;
    branchReview.commitCount = secondRangeCommits.length;

    const secondResult = await reviewService.reviewBranchReview(repoDir, branchReview.id, { force: true });
    expect(secondResult.summary).toBe('review 2');
    expect(providerPrompts).toHaveLength(2);
    expect(providerPrompts[1]).toContain('Incremental review note: this rerun covers only unreviewed commits');
    expect(providerPrompts[1]).toContain(maliciousHeadSha.slice(0, 12));
    expect(providerPrompts[1]).toContain(secondHeadSha.slice(0, 12));
    expect(providerPrompts[1]).toContain('src/second.js');
    expect(providerPrompts[1]).not.toContain('src/first.js');
    expect(branchReview.reviewJson?.stats?.diffScopeMode).toBe('delta');
    expect(branchReview.reviewJson?.stats?.diffBaseSha).toBe(maliciousHeadSha);
    expect(branchReview.reviewJson?.stats?.diffHeadSha).toBe(secondHeadSha);
    expect(branchReview.reviewJson?.stats?.deltaEligible).toBe(true);
    expect(branchReview.reviewHeadSha).toBe(secondHeadSha);
  });
});
