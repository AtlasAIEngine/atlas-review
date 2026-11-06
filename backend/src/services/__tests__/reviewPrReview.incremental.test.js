import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const prReviewState = {
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

function applyPrReviewPatch(target, payload) {
  const fieldMap = {
    review_status: 'reviewStatus',
    review_risk_level: 'reviewRiskLevel',
    review_summary: 'reviewSummary',
    review_error: 'reviewError',
    review_head_sha: 'reviewHeadSha',
    review_json: 'reviewJson',
    reviewed_at: 'reviewedAt',
    head_sha: 'headSha',
    base_sha: 'baseSha',
    head_branch: 'headBranch',
    base_branch: 'baseBranch',
    file_count: 'fileCount',
    total_additions: 'totalAdditions',
    total_deletions: 'totalDeletions',
    commit_count: 'commitCount',
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

async function runGit(cwd, ...args) {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd, ...args) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function gitShowOrNull(cwd, ref, filePath) {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], { cwd });
    return stdout;
  } catch {
    return null;
  }
}

async function createRepoFixture() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-pr-review-incremental-'));
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

async function computePrStats(repoDir, baseSha) {
  const [{ default: gitService }, headSha] = await Promise.all([
    import('../gitService.js'),
    gitOutput(repoDir, 'rev-parse', 'HEAD'),
  ]);
  const diffStats = await gitService.getThreeDotDiffStats(repoDir, baseSha, headSha);
  return {
    headSha,
    baseSha,
    fileCount: diffStats.fileCount,
    totalAdditions: diffStats.totalAdditions,
    totalDeletions: diffStats.totalDeletions,
    commitCount: diffStats.commitCount,
  };
}

async function buildPullRequestCommits(repoDir, baseSha, headSha) {
  const shasRaw = await gitOutput(repoDir, 'rev-list', '--reverse', `${baseSha}..${headSha}`);
  const shas = shasRaw ? shasRaw.split('\n').filter(Boolean) : [];
  const commits = [];
  for (const sha of shas) {
    commits.push({
      sha,
      message: await gitOutput(repoDir, 'show', '-s', '--format=%s', sha),
    });
  }
  return commits;
}

async function buildCompareFiles(repoDir, fromRef, toRef) {
  const { default: gitService } = await import('../gitService.js');
  const [nameStatus, diffStats] = await Promise.all([
    gitService.getTwoDotDiffNameStatus(repoDir, fromRef, toRef),
    gitService.getTwoDotDiffStats(repoDir, fromRef, toRef),
  ]);
  const fileMap = new Map((diffStats.files || []).map((entry) => [entry.path, entry]));
  return {
    files: nameStatus.map((entry) => ({
      filename: entry.path,
      previous_filename: entry.oldPath || null,
      status: entry.status === 'D'
        ? 'removed'
        : entry.status === 'A'
          ? 'added'
          : entry.status === 'R'
            ? 'renamed'
            : 'modified',
      additions: Number(fileMap.get(entry.path)?.additions || 0),
      deletions: Number(fileMap.get(entry.path)?.deletions || 0),
      patch: null,
    })),
    totalAdditions: diffStats.totalAdditions,
    totalDeletions: diffStats.totalDeletions,
    fileCount: diffStats.fileCount,
    commitCount: diffStats.commitCount,
  };
}

async function loadReviewModules(repoDir, options = {}) {
  vi.resetModules();
  const providerTextFactory = typeof options.providerTextFactory === 'function'
    ? options.providerTextFactory
    : null;
  const executionModeOrder = Array.isArray(options.executionModeOrder) && options.executionModeOrder.length > 0
    ? options.executionModeOrder
    : ['api'];
  const resolvedProviderCandidate = {
    ...providerCandidate,
    ...(options.providerCandidateOverride || {}),
  };

  vi.doMock('../providerService.js', () => ({
    default: {
      getContextActiveProvider: vi.fn(async () => null),
      getReviewProviderCandidatesWithKeys: vi.fn(async () => [resolvedProviderCandidate]),
      getActiveProviderWithKey: vi.fn(async () => null),
    },
  }));

  vi.doMock('../prReviewService.js', () => ({
    default: {
      getById: vi.fn(async () => clone(prReviewState.current)),
      updateReview: vi.fn(async (_id, payload) => {
        applyPrReviewPatch(prReviewState.current, payload);
        return clone(prReviewState.current);
      }),
      buildReviewParityGate: vi.fn(() => null),
    },
  }));

  vi.doMock('../githubService.js', () => ({
    default: {
      getPullRequestCommits: vi.fn(async () => (
        buildPullRequestCommits(repoDir, prReviewState.current.baseSha, prReviewState.current.headSha)
      )),
      getCommitCombinedStatus: vi.fn(async () => null),
      getPullRequestDetail: vi.fn(async () => ({
        requested_reviewers: [],
        requested_teams: [],
        assignees: [],
      })),
      getPullRequestReviewThreads: vi.fn(async () => []),
      getRepositoryContents: vi.fn(async (_installationId, _owner, _repo, filePath, ref) => {
        if (options.githubContentsUnavailable) {
          throw new Error('GitHub contents unavailable');
        }
        const content = await gitShowOrNull(repoDir, ref, filePath);
        if (content == null) {
          throw new Error('File not found');
        }
        return { content: Buffer.from(content, 'utf8').toString('base64') };
      }),
      getPullRequestFiles: vi.fn(async () => {
        const compare = await buildCompareFiles(repoDir, prReviewState.current.baseSha, prReviewState.current.headSha);
        return compare.files;
      }),
      getCompareFiles: vi.fn(async (_installationId, _owner, _repo, fromRef, toRef) => (
        buildCompareFiles(repoDir, fromRef, toRef)
      )),
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
        commitMessages: Array.isArray(context.commitMessages) ? context.commitMessages.filter(Boolean) : [],
        verificationStatus: context.verificationStatus || { summary: 'No checks recorded.', lines: [] },
        requestedReviewers: context.requestedReviewers || [],
        assignees: context.assignees || [],
        reviewThreads: context.reviewThreads || [],
        priorFindingHints: [],
        fileRiskContext: [],
        claudeConventions: [],
        projectMetadata: null,
        dismissedPatterns: [],
        queuedCommitShas: context.queuedCommitShas || [],
      })),
    };
  });

  vi.doMock('../review/reviewIgnorePatterns.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
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
      getExecutionModeOrder: vi.fn(async () => executionModeOrder),
      resolveProviderExecutionModes: vi.fn(() => executionModeOrder),
      callProviderForReviewWithFailover: vi.fn(async (_state, prompt) => {
        providerCalls.push(prompt);
        const callCount = providerCalls.length;
        const customText = providerTextFactory ? providerTextFactory({ callCount, prompt }) : null;
        const summary = callCount === 1
          ? 'First PR review summary.'
          : 'Incremental PR review summary.';
        const file = callCount === 1 ? 'src/first.js' : 'src/second.js';
        return {
          text: customText || JSON.stringify({
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
                commentEligible: true,
              },
            ],
          }),
          tokensUsed: { input: 10, output: 20 },
          providerData: resolvedProviderCandidate,
          modelUsed: resolvedProviderCandidate.model,
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

  const [{ default: reviewService }, { default: usageService }] = await Promise.all([
    import('../reviewService.js'),
    import('../usageService.js'),
  ]);

  return { reviewService, usageService };
}

describe('reviewPrReview incremental reruns', () => {
  let repoDir;
  let baseSha;
  let reviewService;
  let usageService;

  beforeEach(async () => {
    providerCalls.length = 0;
    reviewService = null;
    usageService = null;
    repoDir = await createRepoFixture();
    baseSha = await gitOutput(repoDir, 'rev-parse', 'HEAD');
  });

  afterEach(async () => {
    prReviewState.current = null;
    if (repoDir) {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('does a full first PR review and then reruns on only unreviewed commits', async () => {
    ({ reviewService, usageService } = await loadReviewModules(repoDir));
    await runGit(repoDir, 'checkout', '-b', 'feature/pr-incremental');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'a';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add first PR file');

    prReviewState.current = {
      id: 'pr-test-1',
      projectId: 'project-1',
      displayId: 'PR-001',
      githubPrNumber: 42,
      title: 'Feature PR',
      body: 'Adds incremental PR review coverage.',
      authorLogin: 'atlas',
      state: 'open',
      headBranch: 'feature/pr-incremental',
      baseBranch: 'main',
      reviewStatus: 'none',
      reviewRiskLevel: null,
      reviewSummary: null,
      reviewError: null,
      reviewHeadSha: null,
      reviewedAt: null,
      reviewJson: null,
      ...(await computePrStats(repoDir, baseSha)),
    };

    const firstResult = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
    });

    expect(firstResult.stats.diffScopeMode).toBe('full');
    expect(firstResult.stats.deltaFallbackReason).toBe('no_prior_completed_review');
    expect(prReviewState.current.reviewStatus).toBe('reviewed');
    expect(prReviewState.current.reviewHeadSha).toBe(prReviewState.current.headSha);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toContain('src/first.js');
    expect(providerCalls[0]).not.toContain('src/second.js');
    expect(providerCalls[0]).not.toContain('Incremental review note: this rerun covers only unreviewed commits');
    expect(prReviewState.current.reviewJson.estimatedCost).toBeGreaterThan(0);
    expect(prReviewState.current.reviewJson.costSource).toBe('fallback_pricing');
    expect(prReviewState.current.reviewJson.costIsApproximate).toBe(true);
    expect(usageService.recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      reviewType: 'pr_review',
      reviewId: prReviewState.current.id,
      changesetId: null,
      model: providerCandidate.model,
      inputTokens: 10,
      outputTokens: 20,
    }));

    const firstReviewedHead = prReviewState.current.reviewHeadSha;

    await fs.writeFile(path.join(repoDir, 'src', 'second.js'), "export const second = 'b';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/second.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add second PR file');

    Object.assign(prReviewState.current, await computePrStats(repoDir, baseSha), {
      reviewStatus: 'queued',
    });

    const secondResult = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
    });

    expect(secondResult.stats.diffScopeMode).toBe('delta');
    expect(secondResult.stats.deltaFallbackReason).toBeNull();
    expect(secondResult.stats.diffBaseSha).toBe(firstReviewedHead);
    expect(secondResult.stats.diffHeadSha).toBe(prReviewState.current.headSha);
    expect(secondResult.stats.diffScopeCommitCount).toBe(1);
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[1]).toContain('Incremental review note: this rerun covers only unreviewed commits');
    expect(providerCalls[1]).toContain('Previous review summary: First PR review summary.');
    expect(providerCalls[1]).toContain('Previous top findings: [medium] src/first.js: Check first.js.');
    expect(providerCalls[1]).toContain('src/second.js');
    expect(providerCalls[1]).not.toContain('diff --git a/src/first.js b/src/first.js');
    expect(prReviewState.current.reviewJson.stats.diffScopeMode).toBe('delta');
    expect(prReviewState.current.reviewJson.stats.diffScopeCommitCount).toBe(1);
    expect(prReviewState.current.reviewJson.estimatedCost).toBeGreaterThan(0);
    expect(prReviewState.current.reviewJson.costSource).toBe('fallback_pricing');
    expect(prReviewState.current.reviewJson.costIsApproximate).toBe(true);
    expect(usageService.recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      reviewType: 'pr_review',
      reviewId: prReviewState.current.id,
    }));
  });

  it('falls back to local git content when GitHub contents hydration fails', async () => {
    ({ reviewService } = await loadReviewModules(repoDir, {
      githubContentsUnavailable: true,
    }));
    await runGit(repoDir, 'checkout', '-b', 'feature/pr-local-content-fallback');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'local fallback';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add local fallback fixture');

    prReviewState.current = {
      id: 'pr-test-local-content-fallback',
      projectId: 'project-1',
      displayId: 'PR-LOCAL-FALLBACK',
      githubPrNumber: 144,
      title: 'Local content fallback PR',
      body: null,
      authorLogin: 'atlas',
      state: 'open',
      headBranch: 'feature/pr-local-content-fallback',
      baseBranch: 'main',
      reviewStatus: 'none',
      reviewJson: null,
      ...(await computePrStats(repoDir, baseSha)),
    };

    const result = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
    });

    expect(result.stats.diffScopeMode).toBe('full');
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toContain('diff --git a/src/first.js b/src/first.js');
    expect(providerCalls[0]).toContain("+export const first = 'local fallback';");
    expect(providerCalls[0]).not.toContain('only 15 diff characters');
  });

  it('marks PR review as reviewed when the provider returns structured markdown instead of JSON', async () => {
    ({ reviewService } = await loadReviewModules(repoDir, {
      providerTextFactory: () => [
        'Summary:',
        'The PR has one grounded null-safety issue and one follow-up concern.',
        '',
        'Overall risk: medium',
        '',
        'Issues:',
        '- [medium] Missing null guard before timer update',
        '  file: src/first.js',
        '  line: 1',
        '  why: The timer path can run before initialization is complete.',
        '  snippet: first()',
        '  fix: Guard initialization before updating the timer.',
        '',
        'Candidate concerns:',
        '- [low] Follow-up cleanup remains',
        '  file: src/first.js',
        '  line: 1',
        '  why: The cleanup path still needs a second pass.',
        '  snippet: first()',
        '  fix: Review the cleanup call ordering.',
      ].join('\n'),
    }));
    await runGit(repoDir, 'checkout', '-b', 'feature/pr-markdown-recovery');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'a';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add markdown recovery fixture');

    prReviewState.current = {
      id: 'pr-test-markdown',
      projectId: 'project-1',
      displayId: 'PR-MARKDOWN',
      githubPrNumber: 142,
      title: 'Markdown recovery PR',
      body: 'Exercising parse recovery.',
      authorLogin: 'atlas',
      state: 'open',
      headBranch: 'feature/pr-markdown-recovery',
      baseBranch: 'main',
      reviewStatus: 'none',
      reviewJson: null,
      ...(await computePrStats(repoDir, baseSha)),
    };

    const result = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
    });

    expect(prReviewState.current.reviewStatus).toBe('reviewed');
    expect(result.recommendations).toHaveLength(1);
    expect(result.candidateFindings).toHaveLength(1);
    expect(result.stats.parseMode).toBe('section_salvage');
    expect(result.stats.parseRecovered).toBe(true);
  });

  it('keeps PR review terminal when the provider returns long free-form prose', async () => {
    ({ reviewService } = await loadReviewModules(repoDir, {
      providerTextFactory: () => 'The review finished with free-form prose instead of JSON. It still identified a likely initialization ordering regression in src/first.js and recommends manually grounding the exact line before publishing any GitHub comment.',
    }));
    await runGit(repoDir, 'checkout', '-b', 'feature/pr-prose-recovery');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'a';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add prose recovery fixture');

    prReviewState.current = {
      id: 'pr-test-prose',
      projectId: 'project-1',
      displayId: 'PR-PROSE',
      githubPrNumber: 143,
      title: 'Prose recovery PR',
      body: null,
      authorLogin: 'atlas',
      state: 'open',
      headBranch: 'feature/pr-prose-recovery',
      baseBranch: 'main',
      reviewStatus: 'none',
      reviewJson: null,
      ...(await computePrStats(repoDir, baseSha)),
    };

    const result = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
    });

    expect(prReviewState.current.reviewStatus).toBe('reviewed');
    expect(result.summary).toContain('free-form prose');
    expect(result.recommendations).toEqual([]);
    expect(result.stats.parseMode).toBe('minimal_fallback');
    expect(result.stats.parseRecovered).toBe(true);
  });

  it('runs a second extraction pass for agentic_discovery and keeps structured findings', async () => {
    ({ reviewService } = await loadReviewModules(repoDir, {
      executionModeOrder: ['cli-agentic'],
      providerCandidateOverride: {
        provider: {
          type: 'openai',
          model: providerCandidate.model,
          source: 'cli_detected',
        },
        useCodexCLI: true,
      },
      providerTextFactory: ({ callCount }) => {
        if (callCount === 1) {
          return [
            'Summary:',
            'The PR introduces a likely initialization ordering regression.',
            '',
            'Overall risk: high',
            '',
            'Issues:',
            '- [high] Timer subscription can miss the first event',
            '  file: src/first.js',
            '  line: 1',
            '  why: Initialization now happens after the first emission path.',
            '  snippet: export const first = setupTimer();',
            '  fix: Subscribe before the producer can emit or replay the latest state.',
            '',
            'Candidate concerns:',
            'none',
          ].join('\n');
        }
        return JSON.stringify({
          summary: 'The PR introduces a likely initialization ordering regression.',
          riskLevel: 'high',
          changeGroups: [],
          recommendations: [
            {
              type: 'issue',
              severity: 'high',
              title: 'Timer subscription can miss the first event',
              description: 'Initialization now happens after the first emission path.',
              file: 'src/first.js',
              line: 1,
              evidence: {
                file: 'src/first.js',
                line: 1,
                snippet: 'export const first = setupTimer();',
                reasoning: 'Initialization now happens after the first emission path.',
              },
              suggestedFix: 'Subscribe before the producer can emit or replay the latest state.',
            },
          ],
          candidateFindings: [],
          stats: {
            filesAnalyzed: 1,
          },
        });
      },
    }));
    await runGit(repoDir, 'checkout', '-b', 'feature/pr-agentic-two-pass');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = setupTimer();\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add discovery extraction fixture');

    prReviewState.current = {
      id: 'pr-test-agentic-two-pass',
      projectId: 'project-1',
      displayId: 'PR-AGENTIC-TWO-PASS',
      githubPrNumber: 144,
      title: 'Agentic discovery extraction PR',
      body: 'Exercises the two-pass discovery contract.',
      authorLogin: 'atlas',
      state: 'open',
      headBranch: 'feature/pr-agentic-two-pass',
      baseBranch: 'main',
      reviewStatus: 'none',
      reviewJson: null,
      ...(await computePrStats(repoDir, baseSha)),
    };

    const result = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
      reviewMode: 'agentic_discovery',
    });

    expect(prReviewState.current.reviewStatus).toBe('reviewed');
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].title).toContain('Timer subscription');
    expect(result.stats.prPipelineMode).toBe('agentic_discovery');
    expect(result.stats.agenticDiscoveryContract).toBe('two_pass_v1');
    expect(result.stats.agenticDiscoveryExtractionMode).toBe('model');
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[0]).toContain('Return plain text only');
    expect(providerCalls[1]).toContain('This is an extraction pass, not a fresh code review.');
    expect(providerCalls[1]).toContain('Use ONLY findings that are explicitly present in the discovery notes.');
  });

  it('uses agentic discovery for eligible full-scope PR reruns in auto mode', async () => {
    ({ reviewService } = await loadReviewModules(repoDir, {
      executionModeOrder: ['cli-agentic'],
      providerCandidateOverride: {
        provider: {
          type: 'openai',
          model: providerCandidate.model,
          source: 'cli_detected',
        },
        useCodexCLI: true,
      },
      providerTextFactory: ({ callCount }) => {
        if (callCount === 1) {
          return [
            'Summary:',
            'The full rerun should still use discovery mode.',
            '',
            'Overall risk: low',
            '',
            'Issues:',
            'none',
            '',
            'Candidate concerns:',
            'none',
          ].join('\n');
        }
        return JSON.stringify({
          summary: 'The full rerun should still use discovery mode.',
          riskLevel: 'low',
          changeGroups: [],
          recommendations: [],
          candidateFindings: [],
          stats: {
            filesAnalyzed: 3,
          },
        });
      },
    }));
    await runGit(repoDir, 'checkout', '-b', 'feature/pr-auto-agentic-rerun');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'a';\n", 'utf8');
    await fs.writeFile(path.join(repoDir, 'src', 'second.js'), "export const second = 'b';\n", 'utf8');
    await fs.writeFile(path.join(repoDir, 'src', 'third.js'), "export const third = 'c';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js', 'src/second.js', 'src/third.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add auto discovery fixture');

    const prStats = await computePrStats(repoDir, baseSha);
    prReviewState.current = {
      id: 'pr-test-auto-agentic-rerun',
      projectId: 'project-1',
      displayId: 'PR-AUTO-AGENTIC-RERUN',
      githubPrNumber: 145,
      title: 'Auto agentic rerun PR',
      body: null,
      authorLogin: 'atlas',
      state: 'open',
      headBranch: 'feature/pr-auto-agentic-rerun',
      baseBranch: 'main',
      reviewStatus: 'reviewed',
      reviewRiskLevel: 'low',
      reviewSummary: 'Previously reviewed.',
      reviewError: null,
      reviewHeadSha: prStats.headSha,
      reviewedAt: '2026-01-01T00:00:00.000Z',
      reviewJson: {
        summary: 'Previously reviewed.',
        riskLevel: 'low',
        recommendations: [],
        stats: {
          diffMergeBaseSha: baseSha,
        },
      },
      ...prStats,
    };

    const result = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      force: true,
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
      reviewMode: 'auto',
      forceFullScope: true,
    });

    expect(result.stats.prRequestedMode).toBe('auto');
    expect(result.stats.prEffectiveMode).toBe('agentic_discovery');
    expect(result.stats.prPipelineMode).toBe('agentic_discovery');
    expect(result.stats.diffScopeRequestedMode).toBe('full');
    expect(result.stats.diffScopeMode).toBe('full');
    expect(result.stats.deltaFallbackReason).toBe('forced_full_review');
    expect(providerCalls).toHaveLength(2);
  });

  it('keeps large agentic_discovery PR reviews in a single discovery session', async () => {
    ({ reviewService } = await loadReviewModules(repoDir, {
      executionModeOrder: ['cli-agentic'],
      providerCandidateOverride: {
        provider: {
          ...providerCandidate.provider,
          source: 'cli_detected',
        },
        useClaudeCLI: true,
      },
      providerTextFactory: ({ callCount }) => {
        if (callCount === 1) {
          return [
            'Summary:',
            'Large PR review found one likely issue in the first changed file.',
            '',
            'Overall risk: medium',
            '',
            'Issues:',
            '- [medium] Large PR issue',
            '  file: src/file-01.js',
            '  line: 1',
            '  why: The first file demonstrates the risky change.',
            '  snippet: export const value01 = 1;',
            '  fix: Restore the guard before using the value.',
            '',
            'Candidate concerns:',
            'none',
          ].join('\n');
        }
        return JSON.stringify({
          summary: 'Large PR review found one likely issue in the first changed file.',
          riskLevel: 'medium',
          changeGroups: [],
          recommendations: [
            {
              type: 'issue',
              severity: 'medium',
              title: 'Large PR issue',
              description: 'The first file demonstrates the risky change.',
              file: 'src/file-01.js',
              line: 1,
              evidence: {
                file: 'src/file-01.js',
                line: 1,
                snippet: 'export const value01 = 1;',
                reasoning: 'The first file demonstrates the risky change.',
              },
              suggestedFix: 'Restore the guard before using the value.',
            },
          ],
          candidateFindings: [],
          stats: {
            filesAnalyzed: 6,
          },
        });
      },
    }));
    await runGit(repoDir, 'checkout', '-b', 'feature/pr-agentic-large-single-session');
    for (let i = 1; i <= 50; i += 1) {
      const fileName = `file-${String(i).padStart(2, '0')}.js`;
      await fs.writeFile(
        path.join(repoDir, 'src', fileName),
        `export const value${String(i).padStart(2, '0')} = ${i};\n`,
        'utf8'
      );
    }
    await runGit(repoDir, 'add', 'src');
    await runGit(repoDir, 'commit', '-m', 'feat: add large PR discovery fixture');

    prReviewState.current = {
      id: 'pr-test-agentic-large-single-session',
      projectId: 'project-1',
      displayId: 'PR-AGENTIC-LARGE',
      githubPrNumber: 145,
      title: 'Large agentic discovery PR',
      body: 'Ensures large PR discovery does not shard.',
      authorLogin: 'atlas',
      state: 'open',
      headBranch: 'feature/pr-agentic-large-single-session',
      baseBranch: 'main',
      reviewStatus: 'none',
      reviewJson: null,
      ...(await computePrStats(repoDir, baseSha)),
    };

    const result = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
      reviewMode: 'agentic_discovery',
    });

    expect(prReviewState.current.reviewStatus).toBe('reviewed');
    expect(result.recommendations).toHaveLength(1);
    expect(result.stats.prPipelineMode).toBe('agentic_discovery');
    expect(result.stats.agenticTier).toBe('large');
    expect(result.stats.agenticShardCount).toBe(1);
    expect(result.stats.agenticShardResultCount).toBe(1);
    expect(providerCalls).toHaveLength(2);
  });

  it('uses tighter first-pass scope and turn budget for Codex discovery', async () => {
    ({ reviewService } = await loadReviewModules(repoDir, {
      executionModeOrder: ['cli-agentic'],
      providerCandidateOverride: {
        provider: {
          ...providerCandidate.provider,
          source: 'cli_detected',
        },
        useCodexCLI: true,
      },
      providerTextFactory: ({ callCount }) => {
        if (callCount === 1) {
          return [
            'Summary:',
            'Codex found one likely issue in the changed code.',
            '',
            'Overall risk: medium',
            '',
            'Issues:',
            '- [medium] Codex discovery issue',
            '  file: src/file-01.cs',
            '  line: 1',
            '  why: The first changed file shows the risky behavior.',
            '  snippet: public class File01 {}',
            '  fix: Restore the missing guard.',
            '',
            'Candidate concerns:',
            'none',
          ].join('\n');
        }
        return JSON.stringify({
          summary: 'Codex found one likely issue in the changed code.',
          riskLevel: 'medium',
          changeGroups: [],
          recommendations: [
            {
              type: 'issue',
              severity: 'medium',
              title: 'Codex discovery issue',
              description: 'The first changed file shows the risky behavior.',
              file: 'src/file-01.cs',
              line: 1,
              evidence: {
                file: 'src/file-01.cs',
                line: 1,
                snippet: 'public class File01 {}',
                reasoning: 'The first changed file shows the risky behavior.',
              },
              suggestedFix: 'Restore the missing guard.',
            },
          ],
          candidateFindings: [],
          stats: {
            filesAnalyzed: 4,
          },
        });
      },
    }));
    await runGit(repoDir, 'checkout', '-b', 'feature/pr-codex-discovery-budget');
    for (let i = 1; i <= 12; i += 1) {
      const fileName = `file-${String(i).padStart(2, '0')}.cs`;
      await fs.writeFile(
        path.join(repoDir, 'src', fileName),
        `public class File${String(i).padStart(2, '0')} {}\n`,
        'utf8'
      );
    }
    await runGit(repoDir, 'add', 'src');
    await runGit(repoDir, 'commit', '-m', 'feat: add codex discovery budget fixture');

    prReviewState.current = {
      id: 'pr-test-codex-discovery-budget',
      projectId: 'project-1',
      displayId: 'PR-CODEX-DISCOVERY',
      githubPrNumber: 146,
      title: 'Codex discovery PR',
      body: 'Ensures Codex discovery stays code-first and bounded.',
      authorLogin: 'atlas',
      state: 'open',
      headBranch: 'feature/pr-codex-discovery-budget',
      baseBranch: 'main',
      reviewStatus: 'none',
      reviewJson: null,
      ...(await computePrStats(repoDir, baseSha)),
    };

    const result = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
      reviewMode: 'agentic_discovery',
    });

    expect(prReviewState.current.reviewStatus).toBe('reviewed');
    expect(result.stats.prPipelineMode).toBe('agentic_discovery');
    expect(result.stats.agenticMaxTurns).toBe(6);
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[0]).toContain('src/file-01.cs');
    expect(providerCalls[0]).toContain('src/file-04.cs');
    expect(providerCalls[0]).not.toContain('src/file-05.cs');
    expect(providerCalls[0]).toContain('Codex-specific guidance:');
  });

  it('reuses the persisted PR review result when no unreviewed commits remain', async () => {
    ({ reviewService } = await loadReviewModules(repoDir));
    await runGit(repoDir, 'checkout', '-b', 'feature/pr-no-unreviewed');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'a';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add only PR file');

    prReviewState.current = {
      id: 'pr-test-2',
      projectId: 'project-1',
      displayId: 'PR-002',
      githubPrNumber: 84,
      title: 'No-op rerun PR',
      body: null,
      authorLogin: 'atlas',
      state: 'open',
      headBranch: 'feature/pr-no-unreviewed',
      baseBranch: 'main',
      reviewStatus: 'none',
      reviewJson: null,
      ...(await computePrStats(repoDir, baseSha)),
    };

    const firstResult = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
      force: true,
    });
    providerCalls.length = 0;

    const secondResult = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
      force: true,
    });

    expect(providerCalls).toHaveLength(0);
    expect(secondResult.summary).toBe(firstResult.summary);
    expect(secondResult.stats.diffScopeMode).toBe('delta');
    expect(secondResult.stats.diffScopeCommitCount).toBe(0);
    expect(secondResult.stats.deltaFallbackReason).toBe('no_unreviewed_commits');
    expect(secondResult.stats.incrementalSkipped).toBe(true);
    expect(secondResult.stats.incrementalSkippedReason).toBe('no_unreviewed_commits');
    expect(prReviewState.current.reviewStatus).toBe('reviewed');
    expect(prReviewState.current.reviewHeadSha).toBe(prReviewState.current.headSha);
    expect(prReviewState.current.reviewError).toBeNull();
  });

  it('falls back to full PR scope when GitHub compare pagination is truncated', async () => {
    ({ reviewService } = await loadReviewModules(repoDir));
    await runGit(repoDir, 'checkout', '-b', 'feature/pr-truncated-compare');
    await fs.writeFile(path.join(repoDir, 'src', 'first.js'), "export const first = 'a';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/first.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add first PR file');

    prReviewState.current = {
      id: 'pr-test-3',
      projectId: 'project-1',
      displayId: 'PR-003',
      githubPrNumber: 85,
      title: 'Truncated delta compare PR',
      body: null,
      authorLogin: 'atlas',
      state: 'open',
      headBranch: 'feature/pr-truncated-compare',
      baseBranch: 'main',
      reviewStatus: 'none',
      reviewJson: null,
      ...(await computePrStats(repoDir, baseSha)),
    };

    await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
      projectPath: repoDir,
    });

    await fs.writeFile(path.join(repoDir, 'src', 'second.js'), "export const second = 'b';\n", 'utf8');
    await runGit(repoDir, 'add', 'src/second.js');
    await runGit(repoDir, 'commit', '-m', 'feat: add second PR file');
    Object.assign(prReviewState.current, await computePrStats(repoDir, baseSha), {
      reviewStatus: 'queued',
    });

    const { default: githubService } = await import('../githubService.js');
    vi.spyOn(githubService, 'getCompareFiles').mockResolvedValue({
      files: [
        {
          filename: 'src/second.js',
          previous_filename: null,
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: null,
        },
      ],
      totalAdditions: 1,
      totalDeletions: 0,
      fileCount: 1,
      commitCount: 1,
      truncated: true,
    });

    const secondResult = await reviewService.reviewPrReview('project-1', prReviewState.current.id, {
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
    });

    expect(secondResult.stats.diffScopeMode).toBe('full');
    expect(secondResult.stats.deltaFallbackReason).toBe('delta_file_scope_truncated');
    expect(secondResult.stats.fileCount).toBe(2);
    expect(secondResult.stats.totalAdditions).toBe(2);
    expect(secondResult.stats.totalDeletions).toBe(0);
    expect(providerCalls).toHaveLength(2);
    expect(providerCalls[1]).toContain('src/first.js');
    expect(providerCalls[1]).toContain('src/second.js');
  });
});
