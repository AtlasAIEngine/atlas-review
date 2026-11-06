/**
 * Integration tests for the review pipeline
 *
 * Tests the full flow: create changeset → generate diff → build prompt →
 * parse response → score against expectations.
 *
 * Uses the reviewService's exported utilities directly (no AI calls).
 * This validates that the pipeline handles edge cases correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import changesetService from '../changesetService.js';
import reviewService from '../reviewService.js';
import reviewOutcomeService from '../reviewOutcomeService.js';
import branchReviewService from '../branchReviewService.js';
import gitService from '../gitService.js';
import prReviewService from '../prReviewService.js';
import verificationService from '../verificationService.js';
import { buildQueueLifecycle } from '../../utils/reviewLifecycle.js';
import { getReviewProfileById } from '../review/reviewProjectProfileService.js';
import { callProviderForReviewWithFailover } from '../review/reviewProviderExecution.js';

let testProjectPath;

beforeEach(async () => {
  testProjectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-pipeline-'));
});

afterEach(async () => {
  try {
    await fs.rm(testProjectPath, { recursive: true, force: true });
  } catch { /* ignore */ }
  vi.restoreAllMocks();
});

describe('Review pipeline integration', () => {
  describe('Changeset → Diff → Prompt flow', () => {
    it('creates changeset with files and generates valid diff', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Add user endpoint',
        source: 'agent',
        files: [
          { path: 'src/app.js', before: 'const a = 1;', after: 'const a = 2;\nconst b = 3;' },
        ],
      });

      expect(changeset.id).toBeDefined();
      expect(changeset.files).toHaveLength(1);

      const diff = reviewService.generateDiffFromFiles(changeset.files);
      expect(diff).toContain('diff --git');
      expect(diff).toContain('src/app.js');
      expect(diff).toContain('-const a = 1;');
      expect(diff).toContain('+const a = 2;');
      expect(diff).toContain('+const b = 3;');
    });

    it('classifies high-risk files for routing and changeset metadata', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Add migration and billing API',
        source: 'agent',
        files: [
          {
            path: 'db/migrations/202605061200_drop_old_sessions.sql',
            before: null,
            after: 'DROP TABLE old_sessions;',
          },
          {
            path: 'src/api/billing/checkout.ts',
            before: 'export function checkout() {}',
            after: 'export function checkout() { return createStripeSession(); }',
          },
          {
            path: 'src/auth/permissions.ts',
            before: 'export const role = "reader";',
            after: 'export const role = "admin";',
          },
        ],
      });

      expect(changeset.riskFlags.dataMigrationChanges).toBe(true);
      expect(changeset.riskFlags.destructiveDataChanges).toBe(true);
      expect(changeset.riskFlags.publicApiChanges).toBe(true);
      expect(changeset.riskFlags.billingPaymentChanges).toBe(true);
      expect(changeset.riskFlags.authPermissionChanges).toBe(true);
    });

    it('does not classify common collection helper names as destructive data changes', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Add repository cleanup helpers',
        source: 'agent',
        files: [
          {
            path: 'src/repositories/sessionRepository.ts',
            before: 'export async function cleanup() {}',
            after: [
              'export async function cleanup(model) {',
              '  await model.deleteMany({ expired: true });',
              '  cache.removeAll();',
              '  queue.purge();',
              '}',
            ].join('\n'),
          },
        ],
      });

      expect(changeset.riskFlags.destructiveDataChanges).toBe(false);
    });

    it('classifies unfiltered ORM bulk deletes as destructive data changes', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Delete old repository records',
        source: 'agent',
        files: [
          {
            path: 'src/repositories/userRepository.ts',
            before: 'export async function cleanup(model) {}',
            after: [
              'export async function cleanup(model) {',
              '  await model.deleteMany({});',
              '}',
            ].join('\n'),
          },
        ],
      });

      expect(changeset.riskFlags.destructiveDataChanges).toBe(true);
    });

    it('uses hunked diff output for modified files (not full-file replacement)', () => {
      const diff = reviewService.generateDiffFromFiles([
        {
          path: 'src/hunked.js',
          before: 'line1\nline2\nline3\nline4',
          after: 'line1\nLINE2\nline3\nline4',
        },
      ]);

      const removedLines = diff
        .split('\n')
        .filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
      const addedLines = diff
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;

      expect(diff).toContain('@@ -');
      expect(removedLines).toBe(1);
      expect(addedLines).toBe(1);
    });

    it('handles new file (before=null) in diff', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Add config',
        source: 'agent',
        files: [
          { path: 'config.json', before: null, after: '{"port": 3000}' },
        ],
      });

      const diff = reviewService.generateDiffFromFiles(changeset.files);
      expect(diff).toContain('new file');
      expect(diff).toContain('--- /dev/null');
      expect(diff).toContain('+++ b/config.json');
      expect(diff).toContain('+{"port": 3000}');
    });

    it('handles deleted file (after=null) in diff', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Remove old config',
        source: 'agent',
        files: [
          { path: 'old.json', before: '{"old": true}', after: null },
        ],
      });

      const diff = reviewService.generateDiffFromFiles(changeset.files);
      expect(diff).toContain('deleted file');
      expect(diff).toContain('--- a/old.json');
      expect(diff).toContain('+++ /dev/null');
      expect(diff).toContain('-{"old": true}');
    });

    it('generates prompt with title and diff', async () => {
      const files = [
        { path: 'src/index.js', before: 'hello', after: 'world' },
      ];

      const diff = reviewService.generateDiffFromFiles(files);
      const { prompt } = reviewService.buildReviewPrompt(diff, {
        title: 'Test changeset',
        commitMessages: ['fix: update greeting'],
      });

      expect(prompt).toContain('Test changeset');
      expect(prompt).toContain('fix: update greeting');
      expect(prompt).toContain('src/index.js');
      expect(prompt).toContain('senior code reviewer');
    });

    it('generates prompt with risk flags', () => {
      const diff = 'diff --git a/package.json b/package.json\n+new dep';
      const { prompt } = reviewService.buildReviewPrompt(diff, {
        title: 'Update deps',
        riskFlags: { dependencyChanges: true, largeBlastRadius: false },
      });

      expect(prompt).toContain('dependencyChanges');
    });

    it('includes omitted-file context in focused prompt metadata', () => {
      const diff = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b';
      const { prompt } = reviewService.buildReviewPrompt(diff, {
        title: 'Focused review test',
        fileCount: 8,
        omittedFilesCount: 3,
        omittedFiles: ['M src/docs/readme.md', 'M src/config/app.yml'],
      });

      expect(prompt).toContain('Focused review note: 3 file(s) were omitted');
      expect(prompt).toContain('Top omitted files:');
      expect(prompt).toContain('src/docs/readme.md');
    });

    it('includes incremental rerun context when diff scope is delta', () => {
      const diff = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b';
      const { prompt } = reviewService.buildReviewPrompt(diff, {
        title: 'Incremental review test',
        diffScopeMode: 'delta',
        diffBaseSha: 'abc1234',
        diffHeadSha: 'def5678',
        diffScopeCommitCount: 2,
        priorReviewSummary: 'Previous run flagged missing authorization checks.',
        priorReviewFindings: [
          '[high] src/auth.ts: Missing authorization guard',
        ],
      });

      expect(prompt).toContain('Incremental review note: this rerun covers only unreviewed commits');
      expect(prompt).toContain('abc1234..def5678');
      expect(prompt).toContain('Previous review summary: Previous run flagged missing authorization checks.');
      expect(prompt).toContain('Previous top findings: [high] src/auth.ts: Missing authorization guard.');
    });

    it('includes review profile and shaped-scope context in prompts', () => {
      const diff = 'diff --git a/Assets/Scripts/DonateFlow.cs b/Assets/Scripts/DonateFlow.cs\n@@ -1,1 +1,1 @@\n-old\n+new';
      const { prompt } = reviewService.buildReviewPrompt(diff, {
        title: 'Unity scope shaping prompt',
        reviewProfile: {
          id: 'unity_csharp',
          label: 'Unity / C#',
          source: 'preset',
        },
        shapedScope: {
          rawFileCount: 131,
          reviewUnitCount: 28,
          classCounts: {
            deep: 8,
            structural: 10,
            shallow: 4,
            collapsed: 109,
            skip: 0,
          },
        },
      });

      expect(prompt).toContain('Review profile: Unity / C# (preset).');
      expect(prompt).toContain('Stack-aware shaping: 131 raw changed files became 28 review units');
      expect(prompt).toContain('structural 10');
      expect(prompt).toContain('collapsed 109');
    });

    it('includes review policy provenance and guidance in prompts', () => {
      const diff = 'diff --git a/backend/src/routes/payments.js b/backend/src/routes/payments.js\n@@ -1,1 +1,1 @@\n-old\n+new';
      const { prompt } = reviewService.buildReviewPrompt(diff, {
        title: 'Policy-guided prompt',
        reviewPolicy: {
          sourcePath: '.atlas/review-policy.json',
          trustedRef: 'refs/heads/main',
          hash: '1234567890abcdef',
          promptAppend: [
            'Treat billing migrations as high scrutiny changes.',
          ],
          paths: [
            {
              glob: 'backend/src/routes/**',
              fileClass: 'deep',
              mustCheckRules: ['auth_bypass', 'missing_input_validation'],
              promptAppend: 'Prefix any title for these files with PATH_HINT:',
            },
          ],
          rules: {
            mustCheckRules: [
              { id: 'global_auth_check' },
            ],
            suppressionRules: [
              { id: 'style_only_nits' },
            ],
          },
        },
      });

      expect(prompt).toContain('Atlas review policy: file .atlas/review-policy.json');
      expect(prompt).toContain('trusted ref refs/heads/main');
      expect(prompt).toContain('Policy guidance: Treat billing migrations as high scrutiny changes.');
      expect(prompt).toContain('Policy rule hints: must-check global_auth_check; suppress style_only_nits.');
      expect(prompt).toContain('Policy path hints: backend/src/routes/** -> class deep -> checks auth_bypass/missing_input_validation -> guidance Prefix any title for these files with PATH_HINT:.');
    });

    it('captures deterministic prompt-context telemetry when budget caps local context blocks', () => {
      const diff = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b';
      const metadata = {
        title: 'Prompt context telemetry test',
        commitMessages: [
          'feat: add deterministic context budget handling',
          'fix: remove non-deterministic prompt ordering',
          'docs: update playbook',
        ],
        claudeConventions: [
          'Use async/await',
          'Service-heavy backend',
          'Route/API separation',
        ],
        projectMetadata: {
          projectType: 'node',
          configFile: 'package.json',
          availableChecks: {
            lint: true,
            unit: true,
            e2e: false,
          },
        },
        promptContextBudgetChars: 220,
      };

      const { prompt, promptContextTelemetry } = reviewService.buildReviewPrompt(diff, metadata);
      expect(prompt).toContain('### Atlas Local Context: Commit Intent');
      expect(metadata.promptContextTelemetry).toBeUndefined();
      expect(promptContextTelemetry).toBeTruthy();
      expect(promptContextTelemetry.budgetChars).toBe(220);
      expect(promptContextTelemetry.usedChars).toBeLessThanOrEqual(220);
      expect(promptContextTelemetry.truncated).toBe(true);
      expect(promptContextTelemetry.blocks.map((block) => block.id)).toEqual([
        'commit_intent',
        'verification_status',
        'prior_same_hash_findings',
        'file_risk_context',
        'claude_conventions',
        'dismissed_patterns',
        'project_metadata',
      ]);
    });

    it('injects verification status and same-hash prior findings into prompt metadata blocks', () => {
      const diff = 'diff --git a/src/guard.ts b/src/guard.ts\n@@ -1,1 +1,1 @@\n-old\n+new';
      const metadata = {
        title: 'Prompt context continuity',
        commitMessages: ['fix: harden route guard'],
        verificationStatus: {
          lint: 'pass',
          unit: 'fail',
          e2e: 'not_run',
          lastRunAt: '2026-02-22T17:00:00.000Z',
        },
        priorFindingHints: [
          {
            filePath: 'src/guard.ts',
            title: 'Missing authorization check',
            severity: 'high',
            type: 'issue',
            sameHash: true,
          },
          {
            filePath: 'src/legacy.ts',
            title: 'Stale historical finding',
            severity: 'critical',
            type: 'issue',
            sameHash: false,
          },
        ],
        promptContextBudgetChars: 460,
      };

      const { prompt, promptContextTelemetry } = reviewService.buildReviewPrompt(diff, metadata);
      expect(prompt).toContain('### Atlas Local Context: Verification Status');
      expect(prompt).toContain('### Atlas Local Context: Prior Findings');
      expect(prompt).toContain('Missing authorization check');
      expect(prompt).not.toContain('Stale historical finding');

      const verificationBlock = promptContextTelemetry.blocks.find((block) => block.id === 'verification_status');
      const priorBlock = promptContextTelemetry.blocks.find((block) => block.id === 'prior_same_hash_findings');
      expect(verificationBlock?.totalLines).toBeGreaterThan(0);
      expect(priorBlock?.totalLines).toBeGreaterThan(0);
    });

    it('handles multi-file changeset diff generation', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Multi-file change',
        source: 'agent',
        files: [
          { path: 'src/a.js', before: 'a', after: 'a2' },
          { path: 'src/b.js', before: null, after: 'b' },
          { path: 'src/c.js', before: 'c', after: null },
        ],
      });

      const diff = reviewService.generateDiffFromFiles(changeset.files);

      // Should contain all three files
      expect(diff).toContain('src/a.js');
      expect(diff).toContain('src/b.js');
      expect(diff).toContain('src/c.js');

      // Check file-specific markers
      expect(diff).toContain('new file'); // b.js
      expect(diff).toContain('deleted file'); // c.js
    });
  });

  describe('Branch-review verification context resolution', () => {
    it('defaults branch review scope to full when no prior completed review baseline exists', async () => {
      const scope = await reviewService.__testing.resolveBranchReviewDiffScope(testProjectPath, {
        mergeBaseSha: 'base123',
        headSha: 'head456',
        reviewHeadSha: null,
        reviewMergeBaseSha: null,
        reviewedAt: null,
        reviewJson: null,
      });

      expect(scope.mode).toBe('full');
      expect(scope.diffBaseSha).toBe('base123');
      expect(scope.deltaEligible).toBe(false);
      expect(scope.deltaFallbackReason).toBe('no_prior_completed_review');
    });

    it('uses delta branch review scope after a completed prior review when ancestry is intact', async () => {
      vi.spyOn(gitService, 'isAncestorRef').mockResolvedValue(true);

      const scope = await reviewService.__testing.resolveBranchReviewDiffScope(testProjectPath, {
        mergeBaseSha: 'base123',
        headSha: 'head456',
        reviewHeadSha: 'head123',
        reviewMergeBaseSha: 'base123',
        reviewedAt: '2026-03-15T10:00:00.000Z',
        reviewJson: {
          summary: 'Previous review summary',
          recommendations: [],
          stats: {
            reviewTier: 'full',
          },
        },
      });

      expect(scope.mode).toBe('delta');
      expect(scope.diffBaseSha).toBe('head123');
      expect(scope.diffHeadSha).toBe('head456');
      expect(scope.branchMergeBaseSha).toBe('base123');
      expect(scope.deltaEligible).toBe(true);
      expect(scope.deltaFallbackReason).toBeNull();
    });

    it('skips forced auto reruns when no unreviewed commits remain on the branch head', async () => {
      const scope = await reviewService.__testing.resolveBranchReviewDiffScope(testProjectPath, {
        mergeBaseSha: 'base123',
        headSha: 'head456',
        reviewHeadSha: 'head456',
        reviewMergeBaseSha: 'base123',
        reviewedAt: '2026-03-15T10:00:00.000Z',
        reviewJson: {
          summary: 'Previous review summary',
          recommendations: [],
          stats: {
            reviewTier: 'full',
          },
        },
      });

      expect(scope.mode).toBe('delta');
      expect(scope.diffBaseSha).toBe('head456');
      expect(scope.diffHeadSha).toBe('head456');
      expect(scope.deltaEligible).toBe(true);
      expect(scope.skipReview).toBe(true);
      expect(scope.deltaFallbackReason).toBe('no_unreviewed_commits');
    });

    it('falls back to full branch review scope when the prior completed review was partial', async () => {
      const scope = await reviewService.__testing.resolveBranchReviewDiffScope(testProjectPath, {
        mergeBaseSha: 'base123',
        headSha: 'head456',
        reviewHeadSha: 'head123',
        reviewMergeBaseSha: 'base123',
        reviewedAt: '2026-03-15T10:00:00.000Z',
        reviewJson: {
          summary: 'Partial review summary',
          recommendations: [],
          stats: {
            reviewTier: 'partial',
            isPartial: true,
          },
        },
      });

      expect(scope.mode).toBe('full');
      expect(scope.deltaEligible).toBe(false);
      expect(scope.deltaFallbackReason).toBe('no_prior_completed_review');
    });

    it('falls back to full branch review scope when the reviewed head is no longer an ancestor', async () => {
      vi.spyOn(gitService, 'isAncestorRef').mockResolvedValue(false);

      const scope = await reviewService.__testing.resolveBranchReviewDiffScope(testProjectPath, {
        mergeBaseSha: 'base123',
        headSha: 'head789',
        reviewHeadSha: 'head123',
        reviewMergeBaseSha: 'base123',
        reviewedAt: '2026-03-15T10:00:00.000Z',
        reviewJson: {
          summary: 'Previous review summary',
          recommendations: [],
          stats: {
            reviewTier: 'full',
          },
        },
      });

      expect(scope.mode).toBe('full');
      expect(scope.diffBaseSha).toBe('base123');
      expect(scope.deltaEligible).toBe(false);
      expect(scope.deltaFallbackReason).toBe('rebased_or_force_pushed');
    });

    it('prefers actionable verification snapshots from snapshot commit changesets', async () => {
      const headSha = 'a'.repeat(40);
      const mergeBaseSha = 'b'.repeat(40);
      const rangeSha = 'c'.repeat(40);

      vi.spyOn(gitService, 'getCommitsBetween').mockResolvedValue([
        { hash: rangeSha, message: 'feat: run verification' },
      ]);
      const commitLookupSpy = vi.spyOn(changesetService, 'getChangeSetsWithCommit')
        .mockResolvedValueOnce([
          {
            id: 'cs-head',
            verification: { lint: 'not_run', unit: 'not_run', e2e: 'not_run' },
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'cs-range',
            verification: {
              lint: 'pass',
              unit: 'pass',
              e2e: 'pass',
              lastRunAt: '2026-02-22T20:00:00.000Z',
            },
          },
        ]);

      const resolved = await reviewService.__testing.resolveBranchReviewVerificationStatus(
        testProjectPath,
        { headSha, mergeBaseSha }
      );

      expect(resolved?.overallStatus).toBe('pass');
      expect(resolved?.lines?.[0]).toContain('Source changeset: cs-range');
      expect(resolved?.source?.commitSha).toBe(rangeSha.slice(0, 12));
      expect(commitLookupSpy).toHaveBeenNthCalledWith(1, testProjectPath, headSha);
      expect(commitLookupSpy).toHaveBeenNthCalledWith(2, testProjectPath, mergeBaseSha);
      expect(commitLookupSpy).toHaveBeenNthCalledWith(3, testProjectPath, rangeSha);
    });

    it('falls back to not_run when only non-actionable verification snapshots exist', async () => {
      const headSha = 'd'.repeat(40);
      const mergeBaseSha = 'e'.repeat(40);

      vi.spyOn(gitService, 'getCommitsBetween').mockResolvedValue([]);
      vi.spyOn(changesetService, 'getChangeSetsWithCommit')
        .mockResolvedValueOnce([
          {
            id: 'cs-head',
            verification: { lint: 'not_run', unit: 'not_run', e2e: 'not_run' },
          },
        ])
        .mockResolvedValueOnce([]);

      const resolved = await reviewService.__testing.resolveBranchReviewVerificationStatus(
        testProjectPath,
        { headSha, mergeBaseSha }
      );

      expect(resolved?.overallStatus).toBe('not_run');
      expect(resolved?.lines?.[0]).toContain('Source changeset: cs-head');
      expect(resolved?.source?.commitSha).toBe(headSha.slice(0, 12));
    });

    it('returns null when no commit-linked verification snapshots exist', async () => {
      const headSha = 'f'.repeat(40);
      const mergeBaseSha = '0'.repeat(40);

      vi.spyOn(gitService, 'getCommitsBetween').mockResolvedValue([]);
      vi.spyOn(changesetService, 'getChangeSetsWithCommit').mockResolvedValue([]);

      const resolved = await reviewService.__testing.resolveBranchReviewVerificationStatus(
        testProjectPath,
        { headSha, mergeBaseSha }
      );

      expect(resolved).toBeNull();
    });

    it('uses diff-scope SHA overrides when resolving branch review verification snapshots', async () => {
      const branchHeadSha = 'a'.repeat(40);
      const branchMergeBaseSha = 'b'.repeat(40);
      const deltaHeadSha = 'c'.repeat(40);
      const deltaBaseSha = 'd'.repeat(40);
      const commitLookupSpy = vi.spyOn(changesetService, 'getChangeSetsWithCommit')
        .mockResolvedValueOnce([
          {
            id: 'cs-delta-head',
            verification: {
              lint: 'pass',
              unit: 'pass',
              e2e: 'pass',
            },
          },
        ]);

      const resolved = await reviewService.__testing.resolveBranchReviewVerificationStatus(
        testProjectPath,
        {
          headSha: branchHeadSha,
          mergeBaseSha: branchMergeBaseSha,
        },
        {
          headSha: deltaHeadSha,
          mergeBaseSha: deltaBaseSha,
          rangeCommits: [],
        }
      );

      expect(resolved?.overallStatus).toBe('pass');
      expect(resolved?.source?.commitSha).toBe(deltaHeadSha.slice(0, 12));
      expect(commitLookupSpy).toHaveBeenCalledTimes(1);
      expect(commitLookupSpy).toHaveBeenCalledWith(testProjectPath, deltaHeadSha);
    });
  });

  describe('PR-review prompt context resolution', () => {
    it('preserves externally supplied verification summary lines', async () => {
      const signals = await reviewService.__testing.collectPromptContextSignals(testProjectPath, {
        commitMessages: ['feat: add PR review parity'],
        verificationStatus: {
          overallStatus: 'fail',
          lines: [
            'GitHub checks: state=fail',
            'Failing contexts: ci/build, ci/unit',
          ],
        },
        contextFiles: [
          { path: 'src/review.ts', before: 'export const a = 1;', after: 'export const a = 2;' },
        ],
      });

      expect(signals.verificationStatus?.overallStatus).toBe('fail');
      expect(signals.verificationStatus?.lines).toContain('GitHub checks: state=fail');
      expect(signals.verificationStatus?.lines).toContain('Failing contexts: ci/build, ci/unit');
    });

    it('normalizes requestedReviewers and reviewThreads into prepared PR prompt context signals', async () => {
      const signals = await reviewService.__testing.collectPromptContextSignals(testProjectPath, {
        commitMessages: ['feat: add PR review parity'],
        requestedReviewers: ['alice', '@bob', 'alice'],
        assignees: ['owner1', 'owner1'],
        reviewThreads: [
          {
            path: 'src/review.ts',
            line: 18,
            author: 'alice',
            status: 'unresolved',
            summary: 'Authorization branch is still missing a session guard.',
          },
          {
            path: 'src/review.ts',
            line: 18,
            author: 'alice',
            status: 'unresolved',
            summary: 'Authorization branch is still missing a session guard.',
          },
        ],
        contextFiles: [
          { path: 'src/review.ts', before: 'export const a = 1;', after: 'export const a = 2;' },
        ],
      });

      expect(signals.requestedReviewers).toEqual(['alice', 'bob']);
      expect(signals.assignees).toEqual(['owner1']);
      expect(signals.reviewThreads).toEqual([
        'src/review.ts:18 unresolved thread from alice - Authorization branch is still missing a session guard.',
      ]);
    });

    it('builds github verification summaries for PR checks', () => {
      const verificationStatus = reviewService.__testing.buildPrReviewVerificationStatus({
        state: 'failure',
        totalCount: 3,
        contexts: [
          { context: 'ci/build', state: 'failure', description: 'Build failed' },
          { context: 'ci/unit', state: 'success', description: 'Unit passed' },
          { context: 'ci/lint', state: 'pending', description: 'Lint running' },
        ],
      });

      expect(verificationStatus?.overallStatus).toBe('fail');
      expect(verificationStatus?.lines?.[0]).toContain('GitHub checks: state=failure');
      expect(verificationStatus?.lines?.join('\n')).toContain('ci/build');
      expect(verificationStatus?.lines?.join('\n')).toContain('ci/lint');
    });
  });

  describe('PR deterministic signal normalization', () => {
    it('normalizes reviewer, thread, and check signals into bounded prompt-context blocks', () => {
      const promptContext = reviewService.__testing.buildBoundedPromptContextBlocks({
        commitMessages: ['feat: harden PR review context'],
        verificationStatus: {
          overallStatus: 'fail',
          lines: [
            'GitHub checks: state=failure total=4',
            'Failing contexts: ci/build, deploy/preview',
          ],
        },
        requestedReviewers: [
          'alice',
          'bob',
          'alice',
          'ci-bot',
        ],
        assignees: [
          'owner1',
          'owner2',
        ],
        reviewThreads: [
          'backend/src/routes/auth.js:27 unresolved thread from alice - Session guard can be bypassed',
          'frontend/src/App.tsx:88 resolved thread from bob - Loading state copy',
          'backend/src/routes/auth.js:27 unresolved thread from alice - Session guard can be bypassed',
        ],
        budgetChars: 650,
      });

      expect(promptContext.contextText).toContain('### Atlas Local Context: Reviewer Expectations');
      expect(promptContext.contextText).toContain('Requested reviewers: alice, bob, ci-bot');
      expect(promptContext.contextText).toContain('Assignees: owner1, owner2');
      expect(promptContext.contextText).toContain('### Atlas Local Context: Review Threads');
      expect(promptContext.contextText).toContain('unresolved thread from alice');
      expect(promptContext.contextText).not.toMatch(/Session guard can be bypassed[\s\S]*Session guard can be bypassed/);
    });
  });

  describe('PR comment eligibility', () => {
    it('marks only grounded, confident, verifier/corroboration-supported findings as commentable', () => {
      const review = reviewService.__testing.applyPrCommentEligibilityPolicy({
        summary: 'PR review',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Grounded auth gap',
            description: 'Missing auth guard allows a protected route to execute.',
            file: 'backend/src/routes/auth.js',
            line: 27,
            confidence: 'high',
            verifierDecision: 'supported',
            corroboration: {
              status: 'supported',
              reason: 'verification_log_match',
            },
          },
          {
            type: 'issue',
            severity: 'medium',
            title: 'Ungrounded note',
            description: 'No stable anchor.',
            file: 'backend/src/routes/auth.js',
            line: null,
            confidence: 'high',
          },
          {
            type: 'issue',
            severity: 'high',
            title: 'Verifier fallback',
            description: 'Verifier could not support this claim.',
            file: 'backend/src/routes/auth.js',
            line: 31,
            confidence: 'high',
            verifierDecision: 'needs_more_context',
            corroboration: {
              status: 'supported',
              reason: 'verification_log_match',
            },
          },
        ],
        stats: {},
      });

      expect(review.recommendations[0].commentEligible).toBe(true);
      expect(review.recommendations[1].commentEligible).toBe(false);
      expect(review.recommendations[1].commentEligibility?.reasonCodes).toContain('missing_line');
      expect(review.recommendations[2].commentEligible).toBe(false);
      expect(review.recommendations[2].commentEligibility?.reasonCodes).toContain('verifier_not_supported');
      expect(review.stats.commentEligibility).toEqual(expect.objectContaining({
        totalFindings: 3,
        eligibleFindings: 1,
        withheldFindings: 2,
      }));
    });

    it('builds PR parity gate metadata from coverage and comment-eligibility signals', () => {
      const gate = prReviewService.buildReviewParityGate({
        fileCount: 6,
        reviewJson: {
          summary: 'PR review',
          riskLevel: 'high',
          recommendations: [
            {
              type: 'issue',
              severity: 'high',
              title: 'Grounded auth gap',
              description: 'Session guard was removed from an admin route.',
              file: 'backend/src/routes/admin.js',
              line: 27,
              commentEligible: true,
            },
            {
              type: 'issue',
              severity: 'medium',
              title: 'Needs more grounding',
              description: 'This note should stay Atlas-only.',
              file: 'backend/src/routes/admin.js',
              line: 34,
              commentEligible: false,
            },
          ],
          verificationStatus: {
            summary: 'GitHub checks: state=failure total=3',
          },
          stats: {
            reviewTier: 'full',
            filesDeepReviewed: 5,
            filesTotal: 6,
            commentEligibility: {
              totalFindings: 2,
              eligibleFindings: 1,
              withheldFindings: 1,
            },
          },
        },
      });

      expect(gate).toEqual(expect.objectContaining({
        status: 'warn',
        totalFiles: 6,
        deepReviewedFiles: 5,
        eligibleFindings: 1,
        withheldFindings: 1,
      }));
      expect(gate.reasonCodes).toContain('comment_ready_rate_low');
      expect(gate.reasonCodes).not.toContain('verification_summary_missing');
    });

    it('does not assume full deep coverage when PR review stats omit deep-reviewed counts', () => {
      const gate = prReviewService.buildReviewParityGate({
        fileCount: 6,
        reviewJson: {
          summary: 'PR review',
          riskLevel: 'medium',
          recommendations: [],
          verificationStatus: {
            summary: 'GitHub checks: state=success total=2',
          },
          stats: {
            reviewTier: 'full',
          },
        },
      });

      expect(gate).toEqual(expect.objectContaining({
        status: 'blocked',
        totalFiles: 6,
        deepReviewedFiles: 0,
        deepCoverageRate: 0,
      }));
      expect(gate.reasonCodes).toContain('deep_coverage_below_floor');
    });
  });

  describe('Response parsing', () => {
    it('parses valid JSON review', () => {
      const response = JSON.stringify({
        summary: 'Added a new feature.',
        riskLevel: 'low',
        changeGroups: [{
          label: 'Feature',
          description: 'New feature',
          risk: 'low',
          files: [{ path: 'src/app.js', additions: 5, deletions: 0, description: 'Added code' }],
        }],
        recommendations: [{
          type: 'praise',
          severity: 'low',
          title: 'Well structured',
          description: 'Good code.',
          file: 'src/app.js',
          line: 1,
          targetSnippet: null,
          suggestedFix: null,
        }],
        stats: {
          filesAnalyzed: 1,
          totalAdditions: 5,
          totalDeletions: 0,
          estimatedComplexity: 'trivial',
        },
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.summary).toBe('Added a new feature.');
      expect(result.riskLevel).toBe('low');
      // Phase 11: walkthrough is decoupled — fresh review output drops
      // `changeGroups` even when the model echoes it.
      expect(result.changeGroups).toBeNull();
      expect(result.recommendations).toHaveLength(1);
      // null suggestedFix should be deleted
      expect(result.recommendations[0].suggestedFix).toBeUndefined();
    });

    it('drops changeGroups from fresh review output (Phase 11 decoupling)', () => {
      const response = JSON.stringify({
        summary: 'Has change groups but they should be dropped.',
        riskLevel: 'low',
        changeGroups: [{
          label: 'Should be dropped',
          description: 'Walkthrough is now its own artifact',
          risk: 'low',
          files: [{ path: 'src/app.js', additions: 1, deletions: 0, description: 'x' }],
        }],
        recommendations: [],
        stats: { filesAnalyzed: 1, totalAdditions: 1, totalDeletions: 0, estimatedComplexity: 'trivial' },
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.changeGroups).toBeNull();
    });

    it('strips markdown fences from response', () => {
      const response = '```json\n{"summary":"test","riskLevel":"low","changeGroups":[],"recommendations":[],"stats":{"filesAnalyzed":0,"totalAdditions":0,"totalDeletions":0,"estimatedComplexity":"simple"}}\n```';
      const result = reviewService.parseReviewResponse(response);
      expect(result.summary).toBe('test');
    });

    it('normalizes invalid risk levels to medium', () => {
      const response = JSON.stringify({
        summary: 'Test',
        riskLevel: 'extreme',
        changeGroups: [],
        recommendations: [],
        stats: { filesAnalyzed: 0, totalAdditions: 0, totalDeletions: 0, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.riskLevel).toBe('medium');
    });

    it('reconciles overall risk to highest actionable recommendation severity', () => {
      const response = JSON.stringify({
        summary: 'Test',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'high',
          title: 'Potential outage',
          description: 'A guard is missing.',
          file: 'src/service.js',
          line: 42,
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 12, totalDeletions: 1, estimatedComplexity: 'moderate' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        fileCount: 1,
        filePaths: ['src/service.js'],
      });
      expect(result.riskLevel).toBe('high');
    });

    it('does not keep elevated overall risk when actionable findings are medium/low', () => {
      const response = JSON.stringify({
        summary: 'Mixed signals',
        riskLevel: 'high',
        changeGroups: [{
          label: 'Infra',
          description: 'Infra changes',
          risk: 'high',
          files: [{
            path: 'backend/src/routes/settings.js',
            additions: 3,
            deletions: 1,
            description: 'Settings round-trip updates',
          }],
        }],
        recommendations: [
          {
            type: 'issue',
            severity: 'medium',
            title: 'Config fallback is implicit',
            description: 'Add explicit fallback handling for missing env value.',
            file: 'backend/src/routes/settings.js',
            line: 42,
          },
          {
            type: 'suggestion',
            severity: 'low',
            title: 'Refactor helper',
            description: 'Extract repeated parser logic.',
            file: 'backend/src/routes/settings.js',
            line: 21,
          },
        ],
        stats: { filesAnalyzed: 1, totalAdditions: 3, totalDeletions: 1, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        fileCount: 1,
        filePaths: ['backend/src/routes/settings.js'],
      });
      expect(result.riskLevel).toBe('medium');
    });

    it('clamps non-issue high severities to medium', () => {
      const response = JSON.stringify({
        summary: 'Need better inputs',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          {
            type: 'suggestion',
            severity: 'high',
            title: 'Provide accessible source diff for review',
            description: 'Diff context is unavailable; provide accessible source diff.',
          },
        ],
        stats: { filesAnalyzed: 0, totalAdditions: 0, totalDeletions: 0, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        fileCount: 40,
        filePaths: [],
      });
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].type).toBe('suggestion');
      expect(result.recommendations[0].severity).toBe('medium');
      expect(result.riskLevel).toBe('medium');
    });

    it('clamps non-issue high severities even when quality guards are disabled', () => {
      const response = JSON.stringify({
        summary: 'Agentic passthrough payload',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          {
            type: 'suggestion',
            severity: 'high',
            title: 'Provide accessible source diff for review',
            description: 'Diff context is unavailable; provide accessible source diff.',
          },
        ],
        stats: { filesAnalyzed: 0, totalAdditions: 0, totalDeletions: 0, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        fileCount: 40,
        filePaths: [],
        disableQualityGuards: true,
      });
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].type).toBe('suggestion');
      expect(result.recommendations[0].severity).toBe('medium');
      expect(result.riskLevel).toBe('medium');
    });

    it('enforces reviewPolicy.defaults.maxRecommendations as a total recommendations cap', () => {
      const response = JSON.stringify({
        summary: 'Multiple findings surfaced',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'First issue',
            description: 'This breaks an important path.',
            file: 'backend/src/routes/settings.js',
            line: 11,
          },
          {
            type: 'issue',
            severity: 'medium',
            title: 'Second issue',
            description: 'This breaks a secondary path.',
            file: 'backend/src/routes/settings.js',
            line: 22,
          },
          {
            type: 'suggestion',
            severity: 'low',
            title: 'Extra suggestion',
            description: 'This would improve maintainability.',
            file: 'backend/src/routes/settings.js',
            line: 33,
          },
        ],
        stats: { filesAnalyzed: 1, totalAdditions: 3, totalDeletions: 1, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        fileCount: 1,
        filePaths: ['backend/src/routes/settings.js'],
        reviewPolicy: {
          defaults: {
            maxRecommendations: 1,
          },
        },
      });

      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].title).toBe('First issue');
    });

    it('does not elevate risk from praise-only recommendations', () => {
      const response = JSON.stringify({
        summary: 'Looks good',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [{
          type: 'praise',
          severity: 'critical',
          title: 'Great tests',
          description: 'Excellent coverage.',
          file: 'src/tests.spec.js',
          line: 1,
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 2, totalDeletions: 0, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        fileCount: 1,
        filePaths: ['src/tests.spec.js'],
      });
      expect(result.riskLevel).toBe('low');
    });

    it('normalizes invalid recommendation types to suggestion', () => {
      const response = JSON.stringify({
        summary: 'Test',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [{
          type: 'warning',
          severity: 'low',
          title: 'Test',
          description: 'Test',
        }],
        stats: { filesAnalyzed: 0, totalAdditions: 0, totalDeletions: 0, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.recommendations[0].type).toBe('suggestion');
    });

    it('normalizes non-native recommendation aliases to suggestion', () => {
      const response = JSON.stringify({
        summary: 'Alias check',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [
          {
            type: 'nit',
            severity: 'low',
            title: 'Nitpick',
            description: 'Minor cleanup idea.',
          },
          {
            type: 'question',
            severity: 'medium',
            title: 'Clarify behavior',
            description: 'Could this path throw?',
          },
        ],
        stats: { filesAnalyzed: 2, totalAdditions: 5, totalDeletions: 1, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.recommendations.map((rec) => rec.type)).toEqual(['suggestion', 'suggestion']);
    });

    it('enforces final policy caps on persisted review results', () => {
      const result = {
        summary: 'Test',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'First issue',
            description: 'Primary issue',
            file: 'backend/src/routes/settings.js',
            line: 10,
          },
          {
            type: 'issue',
            severity: 'medium',
            title: 'Second issue',
            description: 'Secondary issue',
            file: 'backend/src/routes/settings.js',
            line: 20,
          },
          {
            type: 'suggestion',
            severity: 'low',
            title: 'Suggestion',
            description: 'Helpful improvement',
            file: 'backend/src/routes/settings.js',
            line: 30,
          },
          {
            type: 'praise',
            severity: 'low',
            title: 'Praise',
            description: 'Looks good',
            file: 'backend/src/routes/settings.js',
            line: 40,
          },
        ],
        stats: { filesAnalyzed: 1, totalAdditions: 3, totalDeletions: 1, estimatedComplexity: 'simple' },
      };

      reviewService.__testing.enforceFinalReviewPolicy(result, {
        reviewPolicy: {
          defaults: {
            allowPraise: false,
            maxRecommendations: 1,
          },
        },
      });

      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].title).toBe('First issue');
      expect(result.recommendations.every((recommendation) => recommendation.type !== 'praise')).toBe(true);
      expect(result.riskLevel).toBe('high');
    });

    it('drops change-group payloads from fresh review output even when the model echoes them', () => {
      // Phase 11: walkthrough generation is decoupled. Fresh review must
      // never carry `changeGroups` forward, even if the model echoes the
      // old schema. Legacy reviews keep their persisted `changeGroups` and
      // are read via walkthroughService.getWalkthroughForReview.
      const response = JSON.stringify({
        summary: 'Path compatibility',
        riskLevel: 'medium',
        changeGroups: [{
          label: 'Routing',
          description: 'Route updates',
          risk: 'medium',
          files: [{
            file: 'src\\routes\\auth.js',
            additions: '4',
            deletions: '1',
            description: 'Added guard',
          }],
        }],
        recommendations: [],
        stats: { filesAnalyzed: '1', totalAdditions: '4', totalDeletions: '1', estimatedComplexity: 'moderate' },
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.changeGroups).toBeNull();
    });

    it('normalizes invalid recommendation file anchors to null while preserving explanation text', () => {
      const response = JSON.stringify({
        summary: 'Anchor compatibility',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'high',
          title: 'Missing auth guard',
          description: 'Auth middleware can be bypassed in this branch.',
          file: { path: 'src/auth.js', line: 24 },
          line: 24,
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 10, totalDeletions: 2, estimatedComplexity: 'moderate' },
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].file).toBeNull();
      expect(result.recommendations[0].line).toBeNull();
      expect(result.recommendations[0].description).toContain('Auth middleware can be bypassed');
    });

    it('coerces stats fields and moves non-contract metadata under stats.atlasAgent', () => {
      const response = JSON.stringify({
        summary: 'Metadata compatibility',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [],
        stats: {
          filesAnalyzed: '7',
          totalAdditions: '15',
          totalDeletions: '4',
          estimatedComplexity: 'unknown',
        },
        atlasAgent: {
          providerMode: 'cli-agent',
          sessionId: 'sess_123',
        },
        executionTrace: {
          id: 'trace-1',
        },
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.stats.filesAnalyzed).toBe(7);
      expect(result.stats.totalAdditions).toBe(15);
      expect(result.stats.totalDeletions).toBe(4);
      expect(result.stats.estimatedComplexity).toBe('simple');
      expect(result.atlasAgent).toBeUndefined();
      expect(result.executionTrace).toBeUndefined();
      expect(result.stats.atlasAgent).toBeTruthy();
      expect(result.stats.atlasAgent.providerMode).toBe('cli-agent');
      expect(result.stats.atlasAgent.sessionId).toBe('sess_123');
      expect(result.stats.atlasAgent.topLevel.executionTrace).toEqual({ id: 'trace-1' });
    });

    it('normalizes atlas_review_result.v2 evidence payloads into compatibility-safe anchors', () => {
      const response = JSON.stringify({
        contractVersion: 'atlas_review_result.v2',
        summary: 'Compatibility test.',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'medium',
          title: 'Null guard missing',
          description: 'Potential null dereference.',
          confidence: 'HIGH',
          evidence: {
            file: 'src/service.ts',
            line: 24,
            snippet: 'return data.user.name;',
            reasoning: 'The code reads nested values without null checks.',
          },
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 3, totalDeletions: 1, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        filePaths: ['src/service.ts'],
      });

      expect(result.stats.reviewContractVersion).toBe('atlas_review_result.v2');
      expect(result.recommendations[0].confidence).toBe('high');
      expect(result.recommendations[0].file).toBe('src/service.ts');
      expect(result.recommendations[0].line).toBe(24);
      expect(result.recommendations[0].sourceAnchor).toEqual({
        file: 'src/service.ts',
        line: 24,
        snippet: 'return data.user.name;',
        reasoning: 'The code reads nested values without null checks.',
      });
      expect(result.recommendations[0].patchAnchor).toEqual({
        file: 'src/service.ts',
        line: null,
        startLine: null,
        endLine: null,
        status: 'file_not_in_diff',
      });
      expect(result.recommendations[0].evidenceSnippet).toBe('return data.user.name;');
      expect(result.recommendations[0].evidence).toEqual({
        file: 'src/service.ts',
        line: 24,
        snippet: 'return data.user.name;',
        reasoning: 'The code reads nested values without null checks.',
      });
    });

    it('reanchors multi-line evidence snippets to the last matched rendered diff line', () => {
      const response = JSON.stringify({
        contractVersion: 'atlas_review_result.v2',
        summary: 'Compatibility test.',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'medium',
          title: 'Signal subscriptions leak on destroy',
          description: 'Two subscriptions are created and should be disposed together.',
          evidence: {
            file: 'src/contracts.ts',
            line: 55,
            snippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
            reasoning: 'The pair of subscriptions defines the affected block.',
          },
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 2, totalDeletions: 1, estimatedComplexity: 'simple' },
      });

      const diffText = `diff --git a/src/contracts.ts b/src/contracts.ts
@@ -54,3 +54,4 @@
 _mapViewCombat = Context.UI.GetMediator<MapViewCombat>();
+_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);
+_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);
`;

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        filePaths: ['src/contracts.ts'],
        diffText,
      });

      expect(result.recommendations[0].line).toBe(55);
      expect(result.recommendations[0].sourceAnchor).toEqual({
        file: 'src/contracts.ts',
        line: 55,
        snippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
        reasoning: 'The pair of subscriptions defines the affected block.',
      });
      expect(result.recommendations[0].patchAnchor).toEqual({
        file: 'src/contracts.ts',
        line: 56,
        startLine: 55,
        endLine: 56,
        status: 'exact_block',
      });
      expect(result.recommendations[0].evidence).toEqual({
        file: 'src/contracts.ts',
        line: 55,
        snippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
        reasoning: 'The pair of subscriptions defines the affected block.',
      });
    });

    it('prefers targetSnippet for exact replacement anchoring when evidence is broader than the replacement block', () => {
      const response = JSON.stringify({
        contractVersion: 'atlas_review_result.v2',
        summary: 'Compatibility test.',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'medium',
          title: 'Replace both subscription lines together',
          description: 'The exact replacement range is the paired subscription block.',
          file: 'src/contracts.ts',
          line: 55,
          targetSnippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
          suggestedFix: '_contractFailedSignal?.Dispose();\n_contractStartedSignal?.Dispose();',
          evidence: {
            file: 'src/contracts.ts',
            line: 55,
            snippet: '_mapViewCombat = Context.UI.GetMediator<MapViewCombat>();\n_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
            reasoning: 'The larger block includes the lines being replaced.',
          },
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 2, totalDeletions: 1, estimatedComplexity: 'simple' },
      });

      const diffText = `diff --git a/src/contracts.ts b/src/contracts.ts
@@ -54,3 +54,4 @@
 _mapViewCombat = Context.UI.GetMediator<MapViewCombat>();
+_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);
+_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);
`;

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        filePaths: ['src/contracts.ts'],
        diffText,
      });

      expect(result.recommendations[0].targetSnippet).toBe(
        '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);'
      );
      expect(result.recommendations[0].patchAnchor).toEqual({
        file: 'src/contracts.ts',
        line: 56,
        startLine: 55,
        endLine: 56,
        status: 'exact_block',
      });
    });

    it('reanchors from a strong partial multi-line snippet match when exact block match fails', () => {
      const response = JSON.stringify({
        contractVersion: 'atlas_review_result.v2',
        summary: 'Compatibility test.',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'medium',
          title: 'Signal subscriptions leak on destroy',
          description: 'Two subscriptions are created and should be disposed together.',
          evidence: {
            file: 'src/contracts.ts',
            line: 55,
            snippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_helperOnlyMention = BuildHelper();\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
            reasoning: 'The pair of subscriptions defines the affected block.',
          },
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 2, totalDeletions: 1, estimatedComplexity: 'simple' },
      });

      const diffText = `diff --git a/src/contracts.ts b/src/contracts.ts
@@ -54,3 +54,4 @@
 _mapViewCombat = Context.UI.GetMediator<MapViewCombat>();
+_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);
+_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);
`;

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        filePaths: ['src/contracts.ts'],
        diffText,
      });

      expect(result.recommendations[0].line).toBe(55);
      expect(result.recommendations[0].sourceAnchor).toEqual({
        file: 'src/contracts.ts',
        line: 55,
        snippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_helperOnlyMention = BuildHelper();\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
        reasoning: 'The pair of subscriptions defines the affected block.',
      });
      expect(result.recommendations[0].patchAnchor).toEqual({
        file: 'src/contracts.ts',
        line: 56,
        startLine: 55,
        endLine: 56,
        status: 'partial_block',
      });
      expect(result.recommendations[0].evidence).toEqual({
        file: 'src/contracts.ts',
        line: 55,
        snippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_helperOnlyMention = BuildHelper();\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
        reasoning: 'The pair of subscriptions defines the affected block.',
      });
    });

    it('reanchors to a unique nearby rendered line when only one evidence line is visible in the patch', () => {
      const response = JSON.stringify({
        contractVersion: 'atlas_review_result.v2',
        summary: 'Compatibility test.',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'medium',
          title: 'Signal subscriptions leak on destroy',
          description: 'Two subscriptions are created and should be disposed together.',
          evidence: {
            file: 'src/contracts.ts',
            line: 59,
            snippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
            reasoning: 'The pair of subscriptions defines the affected block.',
          },
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 1, totalDeletions: 1, estimatedComplexity: 'simple' },
      });

      const diffText = `diff --git a/src/contracts.ts b/src/contracts.ts
@@ -59,2 +60,3 @@
+_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);
 _itemDatabaseService = ResolveContextService<IItemDatabaseService>();
`;

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        filePaths: ['src/contracts.ts'],
        diffText,
      });

      expect(result.recommendations[0].line).toBe(59);
      expect(result.recommendations[0].sourceAnchor).toEqual({
        file: 'src/contracts.ts',
        line: 59,
        snippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
        reasoning: 'The pair of subscriptions defines the affected block.',
      });
      expect(result.recommendations[0].patchAnchor).toEqual({
        file: 'src/contracts.ts',
        line: 60,
        startLine: 60,
        endLine: 60,
        status: 'nearby_unique_line',
      });
      expect(result.recommendations[0].evidence).toEqual({
        file: 'src/contracts.ts',
        line: 59,
        snippet: '_contractFailedSignal = SignalService.Subscribe<ContractFailedSignal>(OnContractFailed);\n_contractStartedSignal = SignalService.Subscribe<ContractStartedSignal>(OnContractStarted);',
        reasoning: 'The pair of subscriptions defines the affected block.',
      });
    });

    it('prefers an exact source-line patch anchor before nearby snippet fallback', () => {
      const response = JSON.stringify({
        contractVersion: 'atlas_review_result.v2',
        summary: 'Compatibility test.',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'high',
          title: 'Division by zero when indicator is at map center',
          description: 'The calculation divides by magnitude at the center point.',
          evidence: {
            file: 'src/map.ts',
            line: 407,
            snippet: 'distanceCorrection = radius / relativePos.magnitude;',
            reasoning: 'This is the exact changed line.',
          },
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 1, totalDeletions: 1, estimatedComplexity: 'simple' },
      });

      const diffText = `diff --git a/src/map.ts b/src/map.ts
@@ -404,6 +404,7 @@
 \tvar radius = Mathf.Min(maskRect.width, maskRect.height) / 2;
+\tdistanceCorrection = radius / relativePos.magnitude;
 \tif (relativePos.magnitude > radius)
 \t{
 \t\trelativePos *= distanceCorrection;
`;

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        filePaths: ['src/map.ts'],
        diffText,
      });

      expect(result.recommendations[0].patchAnchor).toEqual({
        file: 'src/map.ts',
        line: 407,
        startLine: 407,
        endLine: 407,
        status: 'exact',
      });
    });

    it('marks unchanged source-line findings as outside_patch while preserving source anchors', () => {
      const response = JSON.stringify({
        contractVersion: 'atlas_review_result.v2',
        summary: 'Compatibility test.',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'high',
          title: 'Potential null-reference crash',
          description: 'Changed initialization can leave a later dereference null.',
          evidence: {
            file: 'src/patrol.ts',
            line: 247,
            snippet: 'if (_uiHandler.HasMarker())\n\t_uiHandler.HidePatrolCommander();',
            reasoning: 'The dereference site is unchanged, but the introduced state change is earlier in the file.',
          },
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 5, totalDeletions: 1, estimatedComplexity: 'simple' },
      });

      const diffText = `diff --git a/src/patrol.ts b/src/patrol.ts
@@ -154,7 +155,14 @@
+\t\tif (_uiHandler == null)
+\t\t\treturn;
`;

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        filePaths: ['src/patrol.ts'],
        diffText,
      });

      expect(result.recommendations[0].line).toBe(247);
      expect(result.recommendations[0].sourceAnchor).toEqual({
        file: 'src/patrol.ts',
        line: 247,
        snippet: 'if (_uiHandler.HasMarker())\n\t_uiHandler.HidePatrolCommander();',
        reasoning: 'The dereference site is unchanged, but the introduced state change is earlier in the file.',
      });
      expect(result.recommendations[0].patchAnchor).toEqual({
        file: 'src/patrol.ts',
        line: null,
        startLine: null,
        endLine: null,
        status: 'outside_patch',
      });
      expect(result.recommendations[0].evidence).toEqual({
        file: 'src/patrol.ts',
        line: 247,
        snippet: 'if (_uiHandler.HasMarker())\n\t_uiHandler.HidePatrolCommander();',
        reasoning: 'The dereference site is unchanged, but the introduced state change is earlier in the file.',
      });
    });

    it('keeps missing-evidence issue as issue (no silent downgrade)', () => {
      const response = JSON.stringify({
        summary: 'Potential correctness issue.',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'high',
          title: 'Missing guard',
          description: 'Could fail under edge cases.',
          file: null,
          line: null,
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 10, totalDeletions: 2, estimatedComplexity: 'moderate' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        filePaths: ['src/service.js'],
      });
      expect(result.recommendations[0].type).toBe('issue');
      expect(result.recommendations[0].evidenceMissing).toBe(true);
      expect(result.recommendations[0].confidence).toBe('low');
    });

    it('demotes ungrounded issues by policy with explicit reason codes', () => {
      const review = {
        summary: 'Auth hardening.',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Cannot verify',
            description: 'Missing anchor details.',
            file: null,
            line: null,
          },
        ],
        stats: {},
      };
      const diff = 'diff --git a/src/auth.js b/src/auth.js\n@@ -1,1 +1,1 @@\n-old\n+new';

      const result = reviewService.__testing.applyEvidencePolicyToReview(review, {
        diffText: diff,
        filePaths: ['src/auth.js'],
        policy: 'demote',
      });

      expect(result.review.recommendations[0].type).toBe('suggestion');
      expect(result.review.recommendations[0].grounding.reasonCodes).toContain('file_missing');
      expect(result.stats.issuesDemoted).toBe(1);
      expect(result.stats.issuesSuppressed).toBe(0);
    });

    it('suppresses ungrounded issues when suppress policy is enabled', () => {
      const review = {
        summary: 'Auth hardening.',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Cannot verify',
            description: 'Missing anchor details.',
            file: null,
            line: null,
          },
          {
            type: 'suggestion',
            severity: 'low',
            title: 'Style cleanup',
            description: 'Minor readability tweak.',
            file: 'src/auth.js',
            line: 1,
          },
        ],
        stats: {},
      };
      const diff = 'diff --git a/src/auth.js b/src/auth.js\n@@ -1,1 +1,1 @@\n-old\n+new';

      const result = reviewService.__testing.applyEvidencePolicyToReview(review, {
        diffText: diff,
        filePaths: ['src/auth.js'],
        policy: 'suppress',
      });

      expect(result.review.recommendations).toHaveLength(1);
      expect(result.review.recommendations[0].type).toBe('suggestion');
      expect(result.stats.issuesSuppressed).toBe(1);
      expect(result.stats.issuesDemoted).toBe(0);
    });

    it('applies tighter recommendation budgets for low-signal responses', () => {
      const recommendations = Array.from({ length: 8 }, (_, index) => ({
        type: index < 2 ? 'suggestion' : 'praise',
        severity: 'low',
        title: `rec-${index + 1}`,
        description: 'Could be improved.',
        file: `src/file-${index + 1}.ts`,
        line: index + 1,
      }));
      const response = JSON.stringify({
        summary: 'Small cleanup.',
        riskLevel: 'low',
        changeGroups: [],
        recommendations,
        stats: { filesAnalyzed: 3, totalAdditions: 12, totalDeletions: 4, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        fileCount: 3,
        filePaths: recommendations.map((rec) => rec.file),
      });

      expect(result.recommendations).toHaveLength(2);
    });

    it('skips quality guards when disableQualityGuards is true', () => {
      const recommendations = Array.from({ length: 8 }, (_, index) => ({
        type: 'suggestion',
        severity: 'low',
        title: `uncapped-rec-${index + 1}`,
        description: 'Keep all recommendations in agentic passthrough mode.',
        file: `src/file-${index + 1}.ts`,
        line: index + 1,
      }));
      const response = JSON.stringify({
        summary: 'Agentic passthrough.',
        riskLevel: 'low',
        changeGroups: [],
        recommendations,
        stats: { filesAnalyzed: 3, totalAdditions: 12, totalDeletions: 4, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        disableQualityGuards: true,
      });

      expect(result.recommendations).toHaveLength(8);
    });

    it('keeps low-signal budget concise for medium-size diffs', () => {
      const recommendations = Array.from({ length: 10 }, (_, index) => ({
        type: index < 3 ? 'suggestion' : 'praise',
        severity: 'low',
        title: `medium-rec-${index + 1}`,
        description: 'Minor style/nit recommendation.',
        file: `src/medium-${index + 1}.ts`,
        line: index + 1,
      }));
      const response = JSON.stringify({
        summary: 'Medium-size cleanup.',
        riskLevel: 'low',
        changeGroups: [],
        recommendations,
        stats: { filesAnalyzed: 24, totalAdditions: 260, totalDeletions: 120, estimatedComplexity: 'moderate' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        fileCount: 24,
        filePaths: recommendations.map((rec) => rec.file),
      });

      expect(result.recommendations).toHaveLength(2);
    });

    it('keeps one extra slot for concentrated high-severity issues', () => {
      const response = JSON.stringify({
        summary: 'Risky update.',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          {
            type: 'issue',
            severity: 'critical',
            title: 'Critical A',
            description: 'Major risk.',
            file: 'src/a.ts',
            line: 11,
          },
          {
            type: 'issue',
            severity: 'high',
            title: 'High B',
            description: 'Major risk.',
            file: 'src/b.ts',
            line: 22,
          },
          {
            type: 'issue',
            severity: 'high',
            title: 'High C',
            description: 'Major risk.',
            file: 'src/c.ts',
            line: 33,
          },
          {
            type: 'suggestion',
            severity: 'medium',
            title: 'Minor D',
            description: 'Style tweak.',
            file: 'src/d.ts',
            line: 44,
          },
        ],
        stats: { filesAnalyzed: 4, totalAdditions: 40, totalDeletions: 8, estimatedComplexity: 'moderate' },
      });

      const result = reviewService.parseReviewResponse(response, {
        qualityMode: 'v2',
        fileCount: 4,
        filePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      });

      expect(result.recommendations).toHaveLength(3);
      expect(result.recommendations.map((rec) => rec.title)).toEqual(['Critical A', 'High B', 'High C']);
    });

    it('preserves non-empty suggestedFix strings', () => {
      const response = JSON.stringify({
        summary: 'Test',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'high',
          title: 'Fix this',
          description: 'SQL injection',
          file: 'app.js',
          line: 5,
          suggestedFix: 'const result = await db.query($1, [name]);',
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 0, totalDeletions: 0, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.recommendations[0].suggestedFix).toBe('const result = await db.query($1, [name]);');
    });

    it('preserves non-empty targetSnippet strings', () => {
      const response = JSON.stringify({
        summary: 'Test',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [{
          type: 'issue',
          severity: 'high',
          title: 'Fix this',
          description: 'SQL injection',
          file: 'app.js',
          line: 5,
          targetSnippet: 'const result = await db.query(query);',
          suggestedFix: 'const result = await db.query($1, [name]);',
        }],
        stats: { filesAnalyzed: 1, totalAdditions: 0, totalDeletions: 0, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.recommendations[0].targetSnippet).toBe('const result = await db.query(query);');
    });

    it('defaults missing recommendations to empty array; changeGroups stays null (Phase 11 decoupling)', () => {
      const response = JSON.stringify({
        summary: 'Test',
        riskLevel: 'low',
        stats: { filesAnalyzed: 0, totalAdditions: 0, totalDeletions: 0, estimatedComplexity: 'simple' },
      });

      const result = reviewService.parseReviewResponse(response);
      // changeGroups is no longer part of the review contract.
      expect(result.changeGroups).toBeNull();
      expect(result.recommendations).toEqual([]);
    });

    it('defaults missing stats', () => {
      const response = JSON.stringify({
        summary: 'Test',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [],
      });

      const result = reviewService.parseReviewResponse(response);
      expect(result.stats).toEqual({
        filesAnalyzed: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        estimatedComplexity: 'simple',
        candidateFindingsCount: 0,
        reviewContractVersion: 'atlas_review_result.v1',
        parseMode: 'strict_json',
        parseRecovered: false,
      });
    });

    it('still throws on short unusable non-JSON output', () => {
      expect(() => reviewService.parseReviewResponse('not json')).toThrow('Failed to parse');
    });

    it('salvages structured markdown review sections into the normal review contract', () => {
      const response = [
        'Summary:',
        'The review surfaced a null risk and one follow-up concern.',
        '',
        'Overall risk: medium',
        '',
        'Issues:',
        '- [medium] Missing null guard before timer update',
        '  file: Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
        '  line: 52',
        '  why: UpdateTimer now dereferences the timer view without an initialization check.',
        '  snippet: _timerView.UpdateTimer()',
        '  fix: Guard the timer view before calling UpdateTimer.',
        '',
        'Candidate concerns:',
        '- [low] Timer localization is still hardcoded',
        '  file: Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
        '  line: 93',
        '  why: The storm timer string is still English-only.',
        '  snippet: "Storm closing"',
        '  fix: Use the localized string path.',
      ].join('\n');

      const result = reviewService.parseReviewResponse(response, { agenticMode: true });
      expect(result.summary).toContain('null risk');
      expect(result.recommendations).toHaveLength(1);
      expect(result.candidateFindings).toHaveLength(1);
      expect(result.stats.parseMode).toBe('section_salvage');
      expect(result.stats.parseRecovered).toBe(true);
    });

    it('uses minimal fallback for longer free-form review text', () => {
      const response = 'The review finished with free-form prose instead of JSON. It points to a likely init ordering regression and recommends manually grounding the exact line before publishing a comment.';
      const result = reviewService.parseReviewResponse(response, { agenticMode: true });
      expect(result.summary).toContain('free-form prose');
      expect(result.stats.parseMode).toBe('minimal_fallback');
      expect(result.stats.parseRecovered).toBe(true);
    });

    it('marks repaired JSON as recovered without using deep fallback tiers', () => {
      const response = '{"summary":"Recovered malformed JSON","riskLevel":"medium","recommendations":[{"type":"issue","severity":"medium","title":"First finding","description":"One","file":"src/one.ts"} {"type":"issue","severity":"low","title":"Second finding","description":"Two","file":"src/two.ts"}]}';
      const result = reviewService.parseReviewResponse(response);
      expect(result.summary).toBe('Recovered malformed JSON');
      expect(result.recommendations).toHaveLength(2);
      expect(result.stats.parseMode).toBe('repaired_json');
      expect(result.stats.parseRecovered).toBe(true);
    });

    it('warns when deep parse recovery is surfaced through the review service consumer path', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const response = [
        'Summary:',
        'The review surfaced a null risk and one follow-up concern.',
        '',
        'Overall risk: medium',
        '',
        'Issues:',
        '- [medium] Missing null guard before timer update',
        '  file: Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
        '  line: 52',
        '  why: UpdateTimer now dereferences the timer view without an initialization check.',
      ].join('\n');

      const result = reviewService.__testing.parseReviewResponseWithVisibility(
        response,
        { agenticMode: true },
        { reviewType: 'branch_review', reviewId: 'br-test-parse', stage: 'standard_review' }
      );

      expect(result.stats.parseMode).toBe('section_salvage');
      expect(result.stats.parseRecovered).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        '[ReviewService] branch_review br-test-parse used deep parse recovery (section_salvage) during standard_review; review may be incomplete.'
      );
    });

    it('warns when minimal fallback is surfaced through the review service consumer path', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const response = 'The review finished with free-form prose instead of JSON. It points to a likely init ordering regression and recommends manually grounding the exact line before publishing a comment.';

      const result = reviewService.__testing.parseReviewResponseWithVisibility(
        response,
        { agenticMode: true },
        { reviewType: 'branch_review', reviewId: 'br-test-minimal', stage: 'standard_review' }
      );

      expect(result.stats.parseMode).toBe('minimal_fallback');
      expect(result.stats.parseRecovered).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        '[ReviewService] branch_review br-test-minimal used deep parse recovery (minimal_fallback) during standard_review; review may be incomplete.'
      );
    });

    it('does not warn for strict or repaired JSON parse modes', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      reviewService.__testing.parseReviewResponseWithVisibility(
        JSON.stringify({
          summary: 'Strict payload',
          riskLevel: 'medium',
          recommendations: [],
          changeGroups: [],
        }),
        {},
        { reviewType: 'branch_review', reviewId: 'br-strict', stage: 'standard_review' }
      );
      reviewService.__testing.parseReviewResponseWithVisibility(
        '{"summary":"Recovered malformed JSON","riskLevel":"medium","recommendations":[{"type":"issue","severity":"medium","title":"First finding","description":"One","file":"src/one.ts"} {"type":"issue","severity":"low","title":"Second finding","description":"Two","file":"src/two.ts"}]}',
        {},
        { reviewType: 'branch_review', reviewId: 'br-repaired', stage: 'standard_review' }
      );

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('repairs invalid backslashes in JSON string fields', () => {
      const response = '{"summary":"Regex uses \\d+ in the validator","riskLevel":"medium","recommendations":[]}';
      const result = reviewService.parseReviewResponse(response);
      expect(result.summary).toBe('Regex uses \\d+ in the validator');
      expect(result.riskLevel).toBe('medium');
    });

    it('repairs missing commas between adjacent JSON values in agentic output', () => {
      const response = '{"summary":"Recovered malformed JSON","riskLevel":"medium","recommendations":[{"type":"issue","severity":"medium","title":"First finding","description":"One","file":"src/one.ts"} {"type":"issue","severity":"low","title":"Second finding","description":"Two","file":"src/two.ts"}]}';
      const result = reviewService.parseReviewResponse(response);
      expect(result.summary).toBe('Recovered malformed JSON');
      expect(result.recommendations).toHaveLength(2);
      expect(result.recommendations[0].title).toBe('First finding');
      expect(result.recommendations[1].title).toBe('Second finding');
    });

    it('synthesizes summary when missing', () => {
      const response = JSON.stringify({ riskLevel: 'low' });
      const result = reviewService.parseReviewResponse(response);
      expect(result.summary).toContain('Automated review completed');
      expect(result.summary).toContain('(low risk)');
    });
  });

  describe('Reliability guardrails', () => {
    it('prioritizes high-risk code paths ahead of docs/config in focused review ordering', () => {
      const ranked = reviewService.__testing.prioritizeNameStatusEntries([
        { path: 'docs/README.md', status: 'M' },
        { path: 'src/routes/auth.js', status: 'M' },
        { path: 'package-lock.json', status: 'M' },
        { path: 'backend/src/middleware/rbac.ts', status: 'M' },
      ]);

      expect(ranked[0].path).toMatch(/(auth|rbac)/);
      expect(ranked[1].path).toMatch(/(auth|rbac)/);
      expect(ranked[ranked.length - 1].path).toBe('docs/README.md');
    });

    it('uses patch-sized estimation so tiny hunks in large files retain deep coverage', () => {
      const largeStableBlock = 'x'.repeat(12000);
      const files = Array.from({ length: 20 }, (_, index) => {
        const before = `const banner = "${largeStableBlock}";\nexport const flag${index} = false;\n`;
        const after = before.replace('false', 'true');
        return {
          path: `src/feature-${String(index).padStart(2, '0')}.ts`,
          status: 'M',
          before,
          after,
        };
      });

      const selected = reviewService.__testing.selectFilesForFocusedReview(files, {
        triggerFileCount: 1,
        triggerDiffChars: 1,
        targetDiffChars: 4000,
        minDeepFiles: 1,
        maxDeepFiles: 40,
      });

      expect(selected.reviewFiles).toHaveLength(20);
      expect(selected.omittedFiles).toHaveLength(0);
      expect(selected.mode).toBe('full');
    });

    it('treats maxDeepFiles below minDeepFiles as minDeepFiles for deterministic selection', () => {
      const files = Array.from({ length: 10 }, (_, index) => ({
        path: `backend/src/module-${index}.ts`,
        status: 'M',
        reviewSizeHint: 100000,
      }));

      const selected = reviewService.__testing.selectFilesForFocusedReview(files, {
        triggerFileCount: 1,
        triggerDiffChars: 1,
        targetDiffChars: 1000,
        minDeepFiles: 5,
        maxDeepFiles: 2,
      });

      expect(selected.mode).toBe('focused');
      expect(selected.reviewFiles).toHaveLength(5);
      expect(selected.omittedFiles).toHaveLength(5);
    });

    it('scales focused coverage budgets for large high-risk branches and preserves priority coverage', () => {
      const largeRiskyFiles = Array.from({ length: 96 }, (_, index) => ({
        path: index < 24
          ? `backend/src/routes/auth-${index}.ts`
          : `frontend/src/components/view-${index}.tsx`,
        status: 'M',
        reviewSizeHint: 26000,
      }));
      const reviewResolution = { budgetClass: 'quality' };
      const planner = reviewService.__testing.deriveFocusedReviewBudgetConfig({
        files: largeRiskyFiles,
        providerData: { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        reviewResolution,
        deadline: {
          remainingMs: () => 280000,
        },
      });
      const baselinePlanner = reviewService.__testing.deriveFocusedReviewBudgetConfig({
        files: Array.from({ length: 24 }, (_, index) => ({
          path: `docs/guide-${index}.md`,
          status: 'M',
          reviewSizeHint: 8000,
        })),
        providerData: { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        reviewResolution: { budgetClass: 'balanced' },
        deadline: {
          remainingMs: () => 280000,
        },
      });
      const selected = reviewService.__testing.selectFilesForFocusedReview(largeRiskyFiles, planner);

      expect(planner.maxDeepFiles).toBeGreaterThanOrEqual(planner.minDeepFiles);
      expect(planner.maxDeepFiles).toBeGreaterThanOrEqual(baselinePlanner.maxDeepFiles);
      expect(planner.targetDiffChars).toBeGreaterThan(baselinePlanner.targetDiffChars);
      expect(selected.reviewFiles.length).toBeGreaterThanOrEqual(Math.max(8, planner.minDeepFiles - 2));
      expect(selected.reviewFiles.some((file) => /auth-/.test(file.path))).toBe(true);
      expect(selected.omittedFiles.length).toBeGreaterThan(0);
      expect(selected.mode).toBe('focused');
    });

    it('expands focused selection in second pass when coverage budget remains', () => {
      const files = Array.from({ length: 10 }, (_, index) => ({
        path: `src/module-${index}.ts`,
        status: 'M',
        reviewSizeHint: 18000,
      }));
      const selected = reviewService.__testing.selectFilesForFocusedReview(files, {
        triggerFileCount: 1,
        triggerDiffChars: 1,
        targetDiffChars: 38000,
        expansionTargetDiffChars: 118000,
        minDeepFiles: 2,
        maxDeepFiles: 8,
      });

      expect(selected.mode).toBe('focused');
      expect(selected.reviewFiles.length).toBeGreaterThan(2);
      expect(selected.reviewFiles.length).toBeLessThanOrEqual(8);
      expect(selected.omittedFiles.length).toBe(files.length - selected.reviewFiles.length);
    });

    it('computes bounded scheduler concurrency with deterministic provider/deadline inputs', () => {
      const latencyPlan = reviewService.__testing.resolveBoundedSchedulerConcurrency({
        path: 'chunk',
        totalUnits: 48,
        providerData: { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        budgetClass: 'latency',
        deadline: { remainingMs: () => 90000 },
        baseline: 3,
        maxConcurrency: 8,
      });
      const qualityPlan = reviewService.__testing.resolveBoundedSchedulerConcurrency({
        path: 'chunk',
        totalUnits: 48,
        providerData: { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        budgetClass: 'quality',
        deadline: { remainingMs: () => 280000 },
        baseline: 3,
        maxConcurrency: 8,
      });

      expect(latencyPlan).toBeGreaterThanOrEqual(1);
      expect(latencyPlan).toBeLessThanOrEqual(8);
      expect(qualityPlan).toBeGreaterThanOrEqual(1);
      expect(qualityPlan).toBeLessThanOrEqual(8);
      expect(latencyPlan).toBeGreaterThanOrEqual(qualityPlan);
    });

    it('resolves provider execution profiles with safe defaults', () => {
      const openaiProfile = reviewService.__testing.resolveProviderReviewExecutionProfile({
        provider: { type: 'openai', model: 'gpt-5.3-codex' },
      });
      const unknownProfile = reviewService.__testing.resolveProviderReviewExecutionProfile({
        provider: { type: 'unknown', model: 'x' },
      });

      expect(openaiProfile.coverageMultiplier).toBeGreaterThan(1);
      expect(openaiProfile.chunkConcurrencyBias).toBeGreaterThan(1);
      expect(unknownProfile.coverageMultiplier).toBe(1);
      expect(unknownProfile.chunkConcurrencyBias).toBe(1);
    });

    it('packs chunk groups using patch-sized estimates instead of full file payloads', () => {
      const stable = 'k'.repeat(10000);
      const files = Array.from({ length: 8 }, (_, index) => {
        const before = `const blob = "${stable}";\nexport const enabled${index} = false;\n`;
        const after = before.replace('false', 'true');
        return {
          path: `src/chunk-${index}.ts`,
          status: 'M',
          before,
          after,
        };
      });

      const chunks = reviewService.__testing.chunkFilesForReview(files, 32000, 12);
      expect(chunks.length).toBeLessThan(files.length);
      expect(chunks.flat().length).toBe(files.length);
    });

    it('captures deterministic first-signal metadata in timing snapshots', () => {
      const timing = reviewService.__testing.createReviewTiming('branch_review', 'br-first-signal');
      const captured = reviewService.__testing.recordFirstSignal(timing, {
        scope: 'chunk',
        chunkIndex: 1,
        totalChunks: 5,
        filesCompleted: 3,
        totalFiles: 14,
      });
      const duplicateCapture = reviewService.__testing.recordFirstSignal(timing, {
        scope: 'chunk',
        chunkIndex: 2,
        totalChunks: 5,
        filesCompleted: 6,
        totalFiles: 14,
      });
      const snapshot = reviewService.__testing.finalizeReviewTiming(timing, 'success');

      expect(captured).toBe(true);
      expect(duplicateCapture).toBe(false);
      expect(snapshot.firstSignal).toBeTruthy();
      expect(snapshot.firstSignal.scope).toBe('chunk');
      expect(snapshot.firstSignal.chunkIndex).toBe(1);
      expect(snapshot.firstSignal.totalChunks).toBe(5);
      expect(snapshot.firstSignal.filesCompleted).toBe(3);
      expect(snapshot.firstSignal.totalFiles).toBe(14);
      expect(snapshot.firstSignal.ms).toBeGreaterThanOrEqual(0);
    });

    it('applies first-signal timing metadata into review stats payloads', () => {
      const reviewResult = {
        summary: 'ok',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [],
        stats: {},
      };
      reviewService.__testing.applyTimingSnapshotToReviewStats(reviewResult, {
        totalMs: 1450,
        firstSignal: {
          ms: 420,
          scope: 'single',
          chunkIndex: 1,
          totalChunks: 1,
          filesCompleted: 8,
          totalFiles: 8,
        },
      });

      expect(reviewResult.stats.reviewTotalDurationMs).toBe(1450);
      expect(reviewResult.stats.firstSignalMs).toBe(420);
      expect(reviewResult.stats.firstSignalScope).toBe('single');
      expect(reviewResult.stats.firstSignalFilesCompleted).toBe(8);
      expect(reviewResult.stats.firstSignalTotalFiles).toBe(8);
      expect(reviewResult.stats.firstSignalCaptured).toBe(true);
    });

    it('normalizes precision issue counters to deterministic numeric defaults', () => {
      const reviewResult = {
        summary: 'ok',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [],
        stats: {},
      };
      const normalized = reviewService.__testing.normalizePrecisionIssueCounters(reviewResult);

      expect(normalized.stats.issuesTotal).toBe(0);
      expect(normalized.stats.issuesGrounded).toBe(0);
      expect(normalized.stats.issuesDemoted).toBe(0);
      expect(normalized.stats.issuesSuppressed).toBe(0);
    });

    it('preserves explicit precision counters when present', () => {
      const reviewResult = {
        summary: 'ok',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [],
        stats: {
          issuesTotal: 4,
          issuesGrounded: 3,
          issuesDemoted: 1,
          issuesSuppressed: 0,
        },
      };
      const normalized = reviewService.__testing.normalizePrecisionIssueCounters(reviewResult);

      expect(normalized.stats.issuesTotal).toBe(4);
      expect(normalized.stats.issuesGrounded).toBe(3);
      expect(normalized.stats.issuesDemoted).toBe(1);
      expect(normalized.stats.issuesSuppressed).toBe(0);
    });

    it('normalizes verifier telemetry counters while preserving recommendation file/line compatibility', () => {
      const reviewResult = {
        summary: 'ok',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Guard missing',
            description: 'Missing guard.',
            file: 'src/service.js',
            line: 42,
          },
        ],
        stats: {
          issuesTotal: 1,
          issuesGrounded: 1,
          issuesDemoted: 0,
          issuesSuppressed: 0,
          verifierSupported: '3',
          verifierUnsupported: '-2',
          verifierNeedsMoreContext: 'n/a',
          verifierSkippedBudget: 4.8,
        },
      };
      const normalized = reviewService.__testing.normalizePrecisionIssueCounters(reviewResult);

      expect(normalized.stats.verifierSupported).toBe(3);
      expect(normalized.stats.verifierUnsupported).toBe(0);
      expect(normalized.stats.verifierNeedsMoreContext).toBe(0);
      expect(normalized.stats.verifierSkippedBudget).toBe(4);
      expect(normalized.recommendations[0].file).toBe('src/service.js');
      expect(normalized.recommendations[0].line).toBe(42);
    });

    it('normalizes corroboration telemetry counters with nested compatibility fields', () => {
      const reviewResult = {
        summary: 'ok',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [],
        stats: {
          corroborationChecked: '4',
          corroborationSupported: '2',
          corroborationUnsupported: '-1',
          corroborationNotApplicable: 1.7,
          corroborationDowngraded: '1',
          corroborationSecuritySensitiveChecked: '3',
          corroborationReasonCounts: {
            verifier_supported: 2,
            missing_corroboration: '2',
          },
        },
      };
      const normalized = reviewService.__testing.normalizePrecisionIssueCounters(reviewResult);

      expect(normalized.stats.corroborationEnabled).toBe(false);
      expect(normalized.stats.corroborationChecked).toBe(4);
      expect(normalized.stats.corroborationSupported).toBe(2);
      expect(normalized.stats.corroborationUnsupported).toBe(0);
      expect(normalized.stats.corroborationNotApplicable).toBe(1);
      expect(normalized.stats.corroborationDowngraded).toBe(1);
      expect(normalized.stats.corroborationSecuritySensitiveChecked).toBe(3);
      expect(normalized.stats.corroboration.reasonCounts).toEqual({
        missing_corroboration: 2,
        verifier_supported: 2,
      });
    });

    it('normalizes queue progress checkpoints for deterministic API payloads', () => {
      const normalized = reviewService.__testing.normalizeQueueProgress({
        phase: 'chunk_inflight',
        currentChunk: '2',
        totalChunks: '8',
        filesCompleted: '5',
        totalFiles: '31',
        activeChunkFiles: '3',
        elapsedSeconds: '17',
        splitDepth: '1',
        splitParts: '2',
        diffScopeMode: 'delta',
        diffScopeCommitCount: '2',
        diffBaseSha: 'abc123456789',
        diffHeadSha: 'def987654321',
      }, 'reviewing');

      expect(normalized.phase).toBe('chunk_inflight');
      expect(normalized.currentChunk).toBe(2);
      expect(normalized.totalChunks).toBe(8);
      expect(normalized.filesCompleted).toBe(5);
      expect(normalized.totalFiles).toBe(31);
      expect(normalized.activeChunkFiles).toBe(3);
      expect(normalized.elapsedSeconds).toBe(17);
      expect(normalized.splitDepth).toBe(1);
      expect(normalized.splitParts).toBe(2);
      expect(normalized.diffScopeMode).toBe('delta');
      expect(normalized.diffScopeCommitCount).toBe(2);
      expect(normalized.diffBaseSha).toBe('abc123456789');
      expect(normalized.diffHeadSha).toBe('def987654321');
      expect(typeof normalized.updatedAt).toBe('string');
    });

    it('normalizes unsupported progress phases to fallback and bounds counters', () => {
      const normalized = reviewService.__testing.normalizeQueueProgress({
        phase: 'unknown_phase',
        currentChunk: '9',
        totalChunks: '8',
        filesCompleted: '40',
        totalFiles: '30',
      }, 'reviewing');

      expect(normalized.phase).toBe('reviewing');
      expect(normalized.currentChunk).toBe(8);
      expect(normalized.totalChunks).toBe(8);
      expect(normalized.filesCompleted).toBe(30);
      expect(normalized.totalFiles).toBe(30);
    });

    it('keeps queue progress counters monotonic when late checkpoints regress', () => {
      const previous = reviewService.__testing.normalizeQueueProgress({
        phase: 'chunk_inflight',
        currentChunk: 4,
        totalChunks: 10,
        filesCompleted: 16,
        totalFiles: 32,
        elapsedSeconds: 42,
        retryAttempt: 1,
        retryMaxAttempts: 3,
      }, 'chunk_inflight');

      const normalized = reviewService.__testing.normalizeQueueProgress({
        phase: 'chunk_inflight',
        currentChunk: 2,
        totalChunks: 8,
        filesCompleted: 12,
        totalFiles: 30,
        elapsedSeconds: 20,
        retryAttempt: 0,
        retryMaxAttempts: 0,
      }, 'chunk_inflight', previous);

      expect(normalized.currentChunk).toBe(4);
      expect(normalized.totalChunks).toBe(10);
      expect(normalized.filesCompleted).toBe(16);
      expect(normalized.totalFiles).toBe(32);
      expect(normalized.elapsedSeconds).toBe(42);
      expect(normalized.retryAttempt).toBe(1);
      expect(normalized.retryMaxAttempts).toBe(3);
    });

    it('preserves agentic progress labels when checkpoint omits them', () => {
      const previous = reviewService.__testing.normalizeQueueProgress({
        phase: 'agentic_tool_use',
        currentChunk: 0,
        totalChunks: 0,
        filesCompleted: 0,
        totalFiles: 40,
        agenticToolSummary: 'Reading: src/api/auth.ts',
        agentName: 'Codex',
      }, 'agentic_tool_use');

      const normalized = reviewService.__testing.normalizeQueueProgress({
        phase: 'agentic_exploration',
        currentChunk: 0,
        totalChunks: 0,
        filesCompleted: 0,
        totalFiles: 40,
      }, 'agentic_exploration', previous);

      expect(normalized.agenticToolSummary).toBe('Reading: src/api/auth.ts');
      expect(normalized.agentName).toBe('Codex');
    });

    it('preserves diff scope metadata when later checkpoints omit it', () => {
      const previous = reviewService.__testing.normalizeQueueProgress({
        phase: 'agentic_tool_use',
        totalFiles: 4,
        diffScopeMode: 'delta',
        diffScopeCommitCount: 1,
        diffBaseSha: 'aaaa1111',
        diffHeadSha: 'bbbb2222',
      }, 'agentic_tool_use');

      const normalized = reviewService.__testing.normalizeQueueProgress({
        phase: 'agentic_exploration',
        totalFiles: 4,
      }, 'agentic_exploration', previous);

      expect(normalized.diffScopeMode).toBe('delta');
      expect(normalized.diffScopeCommitCount).toBe(1);
      expect(normalized.diffBaseSha).toBe('aaaa1111');
      expect(normalized.diffHeadSha).toBe('bbbb2222');
    });

    it('preserves PR mode metadata and scope counts when later checkpoints omit them', () => {
      const previous = reviewService.__testing.normalizeQueueProgress({
        phase: 'agentic_tool_use',
        totalFiles: 32,
        totalPrFiles: 95,
        effectiveReviewFiles: 32,
        prRequestedMode: 'auto',
        prEffectiveMode: 'agentic_discovery',
        prPipelineMode: 'agentic_discovery',
      }, 'agentic_tool_use');

      const normalized = reviewService.__testing.normalizeQueueProgress({
        phase: 'agentic_exploration',
        totalFiles: 32,
      }, 'agentic_exploration', previous);

      expect(normalized.prRequestedMode).toBe('auto');
      expect(normalized.prEffectiveMode).toBe('agentic_discovery');
      expect(normalized.prPipelineMode).toBe('agentic_discovery');
      expect(normalized.totalPrFiles).toBe(95);
      expect(normalized.effectiveReviewFiles).toBe(32);
    });

    it('allows explicit progress reset for requeued reviews', () => {
      const entry = {
        progress: reviewService.__testing.normalizeQueueProgress({
          phase: 'chunk_inflight',
          currentChunk: 5,
          totalChunks: 11,
          filesCompleted: 20,
          totalFiles: 40,
        }, 'chunk_inflight'),
      };

      reviewService.__testing.updateQueueEntryProgress(entry, {
        phase: 'queued',
        currentChunk: 0,
        totalChunks: 0,
        filesCompleted: 0,
        totalFiles: 0,
      }, 'queued', { allowReset: true });

      expect(entry.progress.phase).toBe('queued');
      expect(entry.progress.currentChunk).toBe(0);
      expect(entry.progress.totalChunks).toBe(0);
      expect(entry.progress.filesCompleted).toBe(0);
      expect(entry.progress.totalFiles).toBe(0);
    });

    it('keeps a queued follow-up branch review behind an in-flight run', () => {
      reviewService.__testing.setQueueProcessingForTesting(true);
      reviewService.__testing.seedReviewQueueForTesting([
        {
          id: 'queue-1',
          type: 'branch_review',
          projectId: 'proj-1',
          projectPath: '/tmp/project',
          branchReviewId: 'br-follow-up',
          status: 'reviewing',
        },
      ]);

      const second = reviewService.enqueueBranchReview('/tmp/project', 'br-follow-up', {
        projectId: 'proj-1',
      });

      const queue = reviewService.getQueueStatus()
        .filter((entry) => entry.branchReviewId === 'br-follow-up');

      expect(second.id).not.toBe('queue-1');
      expect(queue).toHaveLength(2);
      expect(queue[0]).toEqual(expect.objectContaining({
        id: 'queue-1',
        status: 'reviewing',
      }));
      expect(queue[1]).toEqual(expect.objectContaining({
        id: second.id,
        status: 'queued',
      }));

      reviewService.__testing.clearReviewQueueForTesting();
      reviewService.__testing.setQueueProcessingForTesting(false);
    });

    it('does not queue a branch follow-up when the active auto review already covers the same head', () => {
      reviewService.__testing.setQueueProcessingForTesting(true);
      reviewService.__testing.seedReviewQueueForTesting([
        {
          id: 'queue-running',
          type: 'branch_review',
          projectId: 'proj-1',
          projectPath: '/tmp/project',
          branchReviewId: 'br-follow-up',
          status: 'reviewing',
          autoReviewSnapshot: {
            headSha: 'same-head',
            mergeBaseSha: 'base-a',
            baseBranch: 'main',
          },
        },
      ]);

      const result = reviewService.enqueueBranchReview('/tmp/project', 'br-follow-up', {
        projectId: 'proj-1',
        autoReviewSnapshot: {
          headSha: 'same-head',
          mergeBaseSha: 'base-a',
          baseBranch: 'main',
        },
      });

      const queue = reviewService.getQueueStatus()
        .filter((entry) => entry.branchReviewId === 'br-follow-up');

      expect(result).toEqual(expect.objectContaining({
        id: 'queue-running',
        alreadyRunning: true,
      }));
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual(expect.objectContaining({
        id: 'queue-running',
        status: 'reviewing',
      }));

      reviewService.__testing.clearReviewQueueForTesting();
      reviewService.__testing.setQueueProcessingForTesting(false);
    });

    it('coalesces repeated branch follow-up queues into the newest pending snapshot', () => {
      reviewService.__testing.setQueueProcessingForTesting(true);
      reviewService.__testing.seedReviewQueueForTesting([
        {
          id: 'queue-running',
          type: 'branch_review',
          projectId: 'proj-1',
          projectPath: '/tmp/project',
          branchReviewId: 'br-follow-up',
          status: 'reviewing',
        },
        {
          id: 'queue-follow-up',
          type: 'branch_review',
          projectId: 'proj-1',
          projectPath: '/tmp/old-worktree',
          branchReviewId: 'br-follow-up',
          status: 'queued',
          autoReviewSnapshot: {
            headSha: 'old-head',
            mergeBaseSha: 'base-a',
            baseBranch: 'main',
          },
        },
      ]);

      const result = reviewService.enqueueBranchReview('/tmp/project', 'br-follow-up', {
        projectId: 'proj-1',
        autoReviewSnapshot: {
          headSha: 'new-head',
          mergeBaseSha: 'base-a',
          baseBranch: 'main',
        },
      });

      const queue = reviewService.getQueueStatus()
        .filter((entry) => entry.branchReviewId === 'br-follow-up');
      const rawQueue = reviewService.__testing.getReviewQueueForTesting()
        .filter((entry) => entry.branchReviewId === 'br-follow-up');

      expect(result.id).toBe('queue-follow-up');
      expect(queue).toHaveLength(2);
      expect(queue.filter((entry) => entry.status === 'queued')).toHaveLength(1);
      expect(rawQueue[1]).toEqual(expect.objectContaining({
        projectPath: '/tmp/project',
      }));
      expect(queue[1]).toEqual(expect.objectContaining({
        id: 'queue-follow-up',
        autoReviewSnapshot: expect.objectContaining({
          headSha: 'new-head',
          mergeBaseSha: 'base-a',
        }),
      }));

      reviewService.__testing.clearReviewQueueForTesting();
      reviewService.__testing.setQueueProcessingForTesting(false);
    });

    it('refreshes a queued branch review to the latest git head before running', async () => {
      vi.spyOn(gitService, 'resolveBranchRef').mockResolvedValue('refs/heads/feature/new-work');
      vi.spyOn(gitService, 'getRefSha').mockResolvedValue('new-head');
      vi.spyOn(gitService, 'getThreeDotDiffStats').mockResolvedValue({
        fileCount: 3,
        totalAdditions: 12,
        totalDeletions: 4,
      });
      const updateReview = vi.spyOn(branchReviewService, 'updateReview').mockResolvedValue({
        id: 'br-latest',
        displayId: 'BR-LATEST',
        branchName: 'feature/new-work',
        baseBranch: 'main',
        mergeBaseSha: 'base-a',
        headSha: 'new-head',
        fileCount: 3,
        totalAdditions: 12,
        totalDeletions: 4,
      });

      const refreshed = await reviewService.__testing.refreshLatestBranchReviewHeadForRun('/tmp/project', {
        id: 'br-latest',
        displayId: 'BR-LATEST',
        branchName: 'feature/new-work',
        baseBranch: 'main',
        mergeBaseSha: 'base-a',
        headSha: 'old-head',
        fileCount: 1,
      });

      expect(refreshed.headSha).toBe('new-head');
      expect(updateReview).toHaveBeenCalledWith('br-latest', expect.objectContaining({
        head_sha: 'new-head',
        file_count: 3,
        total_additions: 12,
        total_deletions: 4,
      }));
      expect(gitService.getThreeDotDiffStats).toHaveBeenCalledWith('/tmp/project', 'base-a', 'new-head');
    });

    it('does not refresh a last-commit branch review when the new head has no parent', async () => {
      vi.spyOn(gitService, 'resolveBranchRef').mockResolvedValue('refs/heads/feature/new-work');
      vi.spyOn(gitService, 'getRefSha').mockImplementation(async (_projectPath, ref) => (
        ref === 'refs/heads/feature/new-work' ? 'new-head' : null
      ));
      const updateReview = vi.spyOn(branchReviewService, 'updateReview').mockResolvedValue(null);
      const getTwoDotDiffStats = vi.spyOn(gitService, 'getTwoDotDiffStats').mockResolvedValue({
        fileCount: 1,
        totalAdditions: 1,
        totalDeletions: 0,
      });

      const originalReview = {
        id: 'br-last-commit',
        displayId: 'BR-LAST',
        branchName: 'feature/new-work',
        baseBranch: 'feature/new-work~last-commit',
        baseBranchSource: 'last_commit',
        mergeBaseSha: 'old-parent',
        forkPointSha: 'old-parent',
        headSha: 'old-head',
        fileCount: 1,
      };
      const refreshed = await reviewService.__testing.refreshLatestBranchReviewHeadForRun('/tmp/project', originalReview);

      expect(refreshed).toBe(originalReview);
      expect(updateReview).not.toHaveBeenCalled();
      expect(getTwoDotDiffStats).not.toHaveBeenCalled();
    });

    it('cancels only the queued follow-up branch review behind an in-flight run', async () => {
      reviewService.__testing.setQueueProcessingForTesting(true);
      reviewService.__testing.seedReviewQueueForTesting([
        {
          id: 'queue-running',
          type: 'branch_review',
          projectId: 'proj-1',
          projectPath: '/tmp/project',
          branchReviewId: 'br-follow-up',
          status: 'reviewing',
        },
        {
          id: 'queue-follow-up',
          type: 'branch_review',
          projectId: 'proj-1',
          projectPath: '/tmp/project',
          branchReviewId: 'br-follow-up',
          status: 'queued',
        },
      ]);

      const result = await reviewService.cancelQueuedReviewEntry('queue-follow-up');
      const queue = reviewService.getQueueStatus()
        .filter((entry) => entry.branchReviewId === 'br-follow-up');

      expect(result).toEqual({ stopped: true, was: 'queued' });
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual(expect.objectContaining({
        id: 'queue-running',
        status: 'reviewing',
      }));

      reviewService.__testing.clearReviewQueueForTesting();
      reviewService.__testing.setQueueProcessingForTesting(false);
    });

    it('maps queue entries to deterministic lifecycle payloads', () => {
      const progress = reviewService.__testing.normalizeQueueProgress({
        phase: 'chunk_inflight',
        currentChunk: 3,
        totalChunks: 9,
        filesCompleted: 12,
        totalFiles: 30,
      }, 'reviewing');

      const lifecycle = buildQueueLifecycle({
        status: 'reviewing',
        progress,
        reviewError: null,
        queuedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: progress.updatedAt,
      });

      expect(lifecycle).toEqual(expect.objectContaining({
        status: 'running',
        phase: 'chunk_inflight',
        isActive: true,
        isTerminal: false,
        canRetry: false,
        error: null,
        sourceStatus: 'reviewing',
      }));
      expect(lifecycle.updatedAt).toBe(progress.updatedAt);
      expect(lifecycle.hasProgress).toBe(true);
    });

    it('maps queued retry checkpoints to canonical retrying lifecycle payloads', () => {
      const progress = reviewService.__testing.normalizeQueueProgress({
        phase: 'provider_retry',
        retryAttempt: 1,
        retryMaxAttempts: 2,
        retryDelayMs: 0,
      }, 'provider_retry');

      const lifecycle = buildQueueLifecycle({
        status: 'queued',
        progress,
        reviewError: 'Review watchdog detected stale runtime',
        queuedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: progress.updatedAt,
      });

      expect(lifecycle).toEqual(expect.objectContaining({
        status: 'retrying',
        phase: 'provider_retry',
        isActive: true,
        isTerminal: false,
        canRetry: false,
        sourceStatus: 'queued',
      }));
      expect(lifecycle.updatedAt).toBe(progress.updatedAt);
      expect(lifecycle.hasProgress).toBe(true);
    });

    it('maps reviewed queue entries with persisted terminal reason metadata to partial lifecycle payloads', () => {
      const lifecycle = buildQueueLifecycle({
        status: 'reviewed',
        progress: {
          phase: 'complete',
          updatedAt: '2026-02-20T10:12:00.000Z',
        },
        reviewError: 'Partial review: 2/4 chunks analyzed before timeout',
        queuedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T10:12:00.000Z',
      });

      expect(lifecycle).toEqual(expect.objectContaining({
        status: 'partial',
        phase: 'partial',
        isActive: false,
        isTerminal: true,
        canRetry: true,
        error: 'Partial review: 2/4 chunks analyzed before timeout',
        sourceStatus: 'reviewed',
      }));
    });

    it('builds deterministic cli-agent request envelopes with revision, scope, limits, and output mode', () => {
      const envelope = reviewService.__testing.buildCliAgentReviewRequest({
        prompt: 'review this diff',
        model: 'gpt-5.3-codex',
        providerData: {
          provider: {
            id: 'cli-openai',
            type: 'openai',
            source: 'cli_detected',
          },
        },
        timeoutMs: 180000,
        requestContext: {
          projectId: 'proj-1',
          reviewType: 'branch_review',
          reviewId: 'br-1',
          branchName: 'feature/auth-hardening',
          baseBranch: 'main',
          headSha: 'head123',
          mergeBaseSha: 'base456',
          includePatterns: ['src/**'],
          excludePatterns: ['docs/**'],
          applyGlobalIgnorePatterns: true,
          fileCount: 12,
          diffChars: 40210,
        },
      });

      expect(envelope.schemaVersion).toBe('atlas.cli-agent-review-request.v1');
      expect(envelope.revision).toEqual(expect.objectContaining({
        projectId: 'proj-1',
        reviewType: 'branch_review',
        reviewId: 'br-1',
        branchName: 'feature/auth-hardening',
        baseBranch: 'main',
        headSha: 'head123',
        mergeBaseSha: 'base456',
      }));
      expect(envelope.scope).toEqual({
        includePatterns: ['src/**'],
        excludePatterns: ['docs/**'],
        applyGlobalIgnorePatterns: true,
      });
      expect(envelope.limits).toEqual(expect.objectContaining({
        timeoutMs: 180000,
        fileCount: 12,
        diffChars: 40210,
      }));
      expect(envelope.output).toEqual(expect.objectContaining({
        mode: 'atlas_review_result',
      }));
      expect(envelope.prompt).toBe('review this diff');
    });

    it('orders provider execution modes with cli-agentic first when CLI runtime is available', () => {
      const original = process.env.ATLAS_REVIEW_CLI_AGENT_ENABLED;
      try {
        process.env.ATLAS_REVIEW_CLI_AGENT_ENABLED = '1';
        const modes = reviewService.__testing.resolveProviderExecutionModes({
          provider: {
            type: 'openai',
            source: 'cli_detected',
          },
          apiKey: 'sk-live-key',
          useCodexCLI: false,
        });
        expect(modes).toEqual(['cli-agentic', 'api', 'cli-agent', 'cli-pipe']);
      } finally {
        if (original === undefined) delete process.env.ATLAS_REVIEW_CLI_AGENT_ENABLED;
        else process.env.ATLAS_REVIEW_CLI_AGENT_ENABLED = original;
      }
    });

    it('keeps OpenCode review CLI-first even when a direct API path is available', () => {
      const modes = reviewService.__testing.resolveProviderExecutionModes({
        provider: {
          type: 'opencode',
          source: 'cli_detected',
        },
        apiKey: 'sk-live-key',
        useOpenCodeCLI: true,
      });

      expect(modes).toEqual(['cli-agentic', 'cli-agent', 'api']);
      expect(modes.indexOf('cli-agent')).toBeLessThan(modes.indexOf('api'));
    });

    it('does not auto-enable cli-agentic fast path for OpenCode branch reviews', () => {
      const enabled = reviewService.__testing.shouldUseCliAgenticFastPath({
        providerData: {
          provider: {
            type: 'opencode',
            source: 'cli_detected',
          },
          apiKey: 'sk-live-key',
          useOpenCodeCLI: true,
        },
        reviewType: 'branch_review',
        requestedMode: 'auto',
      });

      expect(enabled).toBe(false);
    });

    it('keeps OpenCode PR cli-agentic fast path opt-in only', () => {
      const providerData = {
        provider: {
          type: 'opencode',
          source: 'cli_detected',
        },
        apiKey: 'sk-live-key',
        useOpenCodeCLI: true,
      };

      expect(reviewService.__testing.shouldUseCliAgenticFastPath({
        providerData,
        reviewType: 'pr_review',
        requestedMode: 'auto',
      })).toBe(false);

      expect(reviewService.__testing.shouldUseCliAgenticFastPath({
        providerData,
        reviewType: 'pr_review',
        requestedMode: 'agentic_discovery',
      })).toBe(true);
    });

    it('does not auto-upgrade OpenCode PR auto mode to agentic discovery', () => {
      const effectiveMode = reviewService.__testing.resolveEffectivePrReviewRequestedMode('auto', {
        projectPath: '/tmp/project',
        providerData: {
          provider: {
            type: 'opencode',
            source: 'cli_detected',
          },
          apiKey: 'sk-live-key',
          useOpenCodeCLI: true,
        },
        fileCount: 20,
        totalAdditions: 400,
        totalDeletions: 50,
      });

      expect(effectiveMode).toBe('auto');
    });

    it('flags insufficient agentic deep-coverage for google reviews', () => {
      const coverage = reviewService.__testing.evaluateAgenticCoverageResult({
        providerType: 'google',
        totalFiles: 36,
        stats: {
          filesAnalyzed: 3,
        },
      });
      expect(coverage.insufficientCoverage).toBe(true);
      expect(coverage.totalFiles).toBe(36);
      expect(coverage.reportedDeepReviewedFiles).toBe(3);
      expect(coverage.minimumDeepReviewedFiles).toBeGreaterThan(3);
    });

    it('enforces agentic coverage floor universally for all providers', () => {
      const coverage = reviewService.__testing.evaluateAgenticCoverageResult({
        providerType: 'anthropic',
        totalFiles: 36,
        stats: {
          filesAnalyzed: 3,
        },
      });
      expect(coverage.coverageRequired).toBe(true);
      expect(coverage.insufficientCoverage).toBe(true);
      expect(coverage.reportedDeepReviewedFiles).toBe(3);
      expect(coverage.minimumDeepReviewedFiles).toBeGreaterThan(3);
    });

    it('forces full follow-up coverage when agentic fallback reports insufficient deep coverage', () => {
      const focusedSelection = {
        mode: 'focused',
        reviewFiles: [{ path: 'src/a.ts', status: 'M' }],
        omittedFiles: [{ path: 'src/b.ts', status: 'M' }],
        totalFiles: 2,
        planner: { source: 'focused-budget' },
      };
      const allFiles = [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/b.ts', status: 'M' },
      ];
      const coerced = reviewService.__testing.coerceFocusedSelectionForAgenticFallback(
        focusedSelection,
        allFiles,
        { reason: 'insufficient_deep_coverage' }
      );

      expect(coerced.mode).toBe('full');
      expect(coerced.reviewFiles).toEqual(allFiles);
      expect(coerced.omittedFiles).toEqual([]);
      expect(coerced.totalFiles).toBe(2);
      expect(coerced.planner).toEqual(expect.objectContaining({
        source: 'focused-budget',
        forcedFullCoverage: true,
        forceReason: 'agentic_insufficient_deep_coverage',
      }));
    });

    it('keeps focused selection unchanged when fallback reason is unrelated', () => {
      const focusedSelection = {
        mode: 'focused',
        reviewFiles: [{ path: 'src/a.ts', status: 'M' }],
        omittedFiles: [{ path: 'src/b.ts', status: 'M' }],
        totalFiles: 2,
      };
      const coerced = reviewService.__testing.coerceFocusedSelectionForAgenticFallback(
        focusedSelection,
        [{ path: 'src/a.ts', status: 'M' }, { path: 'src/b.ts', status: 'M' }],
        { reason: 'provider_error' }
      );
      expect(coerced).toBe(focusedSelection);
    });

    it('prefers local git scope for PR agentic reviews when repo context exists', async () => {
      const nameStatusLoader = vi.fn().mockResolvedValue([
        { path: 'src/auth/guard.ts', status: 'M' },
        { path: 'package-lock.json', status: 'M' },
        { path: 'dist/bundle.js', status: 'M' },
      ]);
      const diffStatLoader = vi.fn().mockResolvedValue({
        files: [{ path: 'src/auth/guard.ts', additions: 14, deletions: 2 }],
      });

      const result = await reviewService.__testing.preparePrReviewScope({
        projectPath: testProjectPath,
        mergeBaseSha: 'base123',
        headSha: 'head456',
        ignorePatterns: ['dist/**'],
        nameStatusLoader,
        diffStatLoader,
      });

      expect(result.source).toBe('local_git');
      expect(result.reviewableNameStatus).toEqual([
        { path: 'src/auth/guard.ts', status: 'M' },
      ]);
      expect(result.focusedSelectionInput).toHaveLength(1);
      expect(result.focusedSelectionInput[0].path).toBe('src/auth/guard.ts');
      expect(result.focusedSelectionInput[0].reviewSizeHint).toBeGreaterThan(0);
      expect(nameStatusLoader).toHaveBeenCalledOnce();
      expect(diffStatLoader).toHaveBeenCalledOnce();
    });

    it('returns an empty GitHub fallback scope before PR file metadata is fetched', async () => {
      const result = await reviewService.__testing.preparePrReviewScope({
        projectPath: testProjectPath,
        mergeBaseSha: 'base123',
        headSha: 'head456',
        ignorePatterns: ['docs/**'],
        nameStatusLoader: vi.fn().mockRejectedValue(new Error('git unavailable')),
        diffStatLoader: vi.fn(),
      });

      expect(result).toEqual({
        source: 'github',
        reviewableNameStatus: [],
        focusedSelectionInput: [],
        diffStats: {
          fileCount: 0,
          totalAdditions: 0,
          totalDeletions: 0,
          commitCount: 0,
        },
        shapedScopeTelemetry: {
          profileId: 'generic',
          rawFileCount: 0,
          reviewUnitCount: 0,
          pairedFiles: 0,
          classCounts: {
            deep: 0,
            structural: 0,
            shallow: 0,
            collapsed: 0,
            skip: 0,
          },
        },
      });
    });

    it('falls back to GitHub file metadata when local PR scope discovery fails and GitHub files are available', async () => {
      const result = await reviewService.__testing.preparePrReviewScope({
        projectPath: testProjectPath,
        mergeBaseSha: 'base123',
        headSha: 'head456',
        ignorePatterns: ['docs/**'],
        ghFiles: [
          { filename: 'src/pr.ts', status: 'modified', additions: 6, deletions: 1 },
          { filename: 'docs/guide.md', status: 'modified', additions: 2, deletions: 0 },
        ],
        nameStatusLoader: vi.fn().mockRejectedValue(new Error('git unavailable')),
        diffStatLoader: vi.fn(),
      });

      expect(result.source).toBe('github');
      expect(result.diffStats).toEqual({
        fileCount: 1,
        totalAdditions: 6,
        totalDeletions: 1,
        commitCount: 0,
      });
      expect(result.reviewableNameStatus).toEqual([
        {
          path: 'src/pr.ts',
          oldPath: null,
          status: 'M',
          additions: 6,
          deletions: 1,
          patch: null,
        },
      ]);
      expect(result.focusedSelectionInput).toHaveLength(1);
      expect(result.focusedSelectionInput[0].path).toBe('src/pr.ts');
      expect(result.focusedSelectionInput[0].reviewSizeHint).toBeGreaterThan(0);
    });

    it('shapes Unity PR scope into logical review units before budgeting', async () => {
      const result = await reviewService.__testing.preparePrReviewScope({
        ghFiles: [
          { filename: 'Assets/Scripts/DonateFlow.cs', status: 'modified', additions: 24, deletions: 3 },
          { filename: 'Assets/Prefabs/DonateButton.prefab', status: 'modified', additions: 10, deletions: 4 },
          { filename: 'Assets/Prefabs/DonateButton.prefab.meta', status: 'modified', additions: 1, deletions: 1 },
          { filename: 'Assets/Art/DataDonate.mat', status: 'added', additions: 5, deletions: 0 },
          { filename: 'Assets/Art/DataDonate.mat.meta', status: 'added', additions: 1, deletions: 0 },
        ],
        ignorePatterns: [],
        reviewProfile: getReviewProfileById('unity_csharp'),
      });

      expect(result.source).toBe('github');
      expect(result.focusedSelectionInput.map((entry) => entry.path)).toEqual([
        'Assets/Scripts/DonateFlow.cs',
        'Assets/Prefabs/DonateButton.prefab',
      ]);
      expect(result.focusedSelectionInput[1].memberPaths).toEqual([
        'Assets/Prefabs/DonateButton.prefab',
        'Assets/Prefabs/DonateButton.prefab.meta',
      ]);
      expect(result.shapedScopeTelemetry).toEqual({
        profileId: 'unity_csharp',
        rawFileCount: 5,
        reviewUnitCount: 2,
        pairedFiles: 1,
        classCounts: {
          deep: 1,
          structural: 1,
          shallow: 0,
          collapsed: 3,
          skip: 0,
        },
      });
    });

    it('routes 59-file CLI-agentic runs into the large tier with a tighter turn budget', () => {
      expect(reviewService.__testing.computeAgenticMaxTurns(59)).toBe(24);
    });

    it('accepts PR agentic fast-path results without falling back when coverage floor is not required', async () => {
      const providerData = {
        provider: {
          id: 'cli-openai',
          type: 'openai',
          model: 'gpt-5.3-codex',
          source: 'cli_detected',
        },
      };
      const reviewTiming = reviewService.__testing.createReviewTiming('pr_review', 'pr-1');
      const markModelUsed = vi.fn();

      const result = await reviewService.__testing.runCliAgenticReviewFastPath({
        reviewType: 'pr_review',
        reviewId: 'pr-1',
        projectId: 'proj-1',
        projectPath: testProjectPath,
        providerData,
        providerFailoverState: { candidates: [providerData], preferredIndex: 0 },
        reviewModelConfig: { strategy: 'smart' },
        unavailableModels: new Set(),
        executionModeOrder: ['cli-agentic', 'api'],
        deadline: { check: vi.fn(), signal: null },
        reviewTiming,
        emitProgress: vi.fn(),
        markModelUsed,
        fileHintsInput: [
          { path: 'src/a.ts', status: 'M', reviewSizeHint: 120 },
          { path: 'src/b.ts', status: 'A', reviewSizeHint: 80 },
        ],
        ignorePatterns: [],
        branchName: 'feature/pr-fast-path',
        baseBranch: 'main',
        mergeBaseSha: 'base123',
        headSha: 'head456',
        totalAdditions: 10,
        totalDeletions: 2,
        qualityMode: 'v2',
        diffLoader: vi.fn().mockResolvedValue(''),
        providerCaller: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            summary: 'Direct agentic PR review',
            riskLevel: 'medium',
            changeGroups: [{
              label: 'Core',
              description: 'Core change',
              risk: 'medium',
              files: [
                { path: 'src/a.ts', additions: 3, deletions: 1, description: 'Updated a.ts' },
                { path: 'src/b.ts', additions: 7, deletions: 1, description: 'Added b.ts' },
              ],
            }],
            recommendations: [],
            stats: {
              filesAnalyzed: 2,
              totalAdditions: 10,
              totalDeletions: 2,
              estimatedComplexity: 'moderate',
            },
          }),
          tokensUsed: { input: 100, output: 50 },
          modelUsed: 'gpt-5.3-codex',
          providerData,
          agenticMeta: {
            actualTurns: 4,
            completionReason: 'success',
            costUsd: 0.12,
          },
        }),
      });

      expect(result.accepted).toBe(true);
      expect(result.fallbackMeta).toBeNull();
      expect(result.reviewResult?.stats?.executionMode).toBe('cli-agentic');
      expect(result.reviewResult?.stats?.agenticReview).toBe(true);
      expect(result.reviewResult?.stats?.reviewModelStrategy).toBe('smart');
      expect(result.tokenUsage).toEqual({ input: 100, output: 50 });
      expect(markModelUsed).toHaveBeenCalledWith('review', 'gpt-5.3-codex');
    });

    it('falls back to structured review when non-large agentic review times out', async () => {
      const providerData = {
        provider: {
          id: 'cli-anthropic',
          type: 'anthropic',
          model: 'claude-sonnet-4-6',
          source: 'cli_detected',
        },
      };
      const providerError = Object.assign(
        new Error('Claude CLI-agentic stuck: no output for 192s'),
        { runtimeCode: 'timeout' }
      );

      const result = await reviewService.__testing.runCliAgenticReviewFastPath({
        reviewType: 'branch_review',
        reviewId: 'br-timeout',
        projectId: 'proj-1',
        projectPath: testProjectPath,
        providerData,
        providerFailoverState: { candidates: [providerData], preferredIndex: 0 },
        reviewModelConfig: { strategy: 'adaptive' },
        unavailableModels: new Set(),
        executionModeOrder: ['cli-agentic', 'api'],
        deadline: { check: vi.fn(), signal: null },
        reviewTiming: reviewService.__testing.createReviewTiming('branch_review', 'br-timeout'),
        emitProgress: vi.fn(),
        markModelUsed: vi.fn(),
        fileHintsInput: [
          { path: 'src/a.ts', status: 'M', reviewSizeHint: 120 },
        ],
        ignorePatterns: [],
        branchName: 'feature/timeout',
        baseBranch: 'main',
        mergeBaseSha: 'base123',
        headSha: 'head456',
        totalAdditions: 10,
        totalDeletions: 2,
        qualityMode: 'v2',
        diffLoader: vi.fn().mockResolvedValue(''),
        providerCaller: vi.fn().mockRejectedValue(providerError),
      });

      expect(result.accepted).toBe(false);
      expect(result.reviewResult).toBeNull();
      expect(result.fallbackMeta).toMatchObject({
        mode: 'diff_followup',
        reason: 'agentic_runtime_failure',
        errorClass: 'timeout',
      });
    });

    it('promotes supported PR agentic candidate findings through the verifier pass', async () => {
      const providerData = {
        provider: {
          id: 'cli-openai',
          type: 'openai',
          model: 'gpt-5.3-codex',
          source: 'cli_detected',
        },
      };
      const reviewTiming = reviewService.__testing.createReviewTiming('pr_review', 'pr-candidate');
      const emitHeartbeat = vi.fn();
      const providerCaller = vi.fn(async () => {
        if (providerCaller.mock.calls.length === 1) {
          return {
            text: JSON.stringify({
              summary: 'Direct agentic PR review with a candidate finding.',
              riskLevel: 'medium',
              changeGroups: [],
              recommendations: [],
              candidateFindings: [{
                type: 'issue',
                severity: 'medium',
                title: 'Candidate issue can be promoted',
                description: 'The changed branch can now call the missing guard path.',
                file: 'src/a.ts',
                line: 12,
                evidence: {
                  file: 'src/a.ts',
                  line: 12,
                  snippet: 'runWithoutGuard();',
                  reasoning: 'The changed branch can now call the missing guard path.',
                },
                suggestedFix: 'Restore the guard before running the branch.',
              }],
              stats: {
                filesAnalyzed: 1,
              },
            }),
            tokensUsed: { input: 100, output: 50 },
            modelUsed: 'gpt-5.3-codex',
            providerData,
            agenticMeta: {
              actualTurns: 4,
              completionReason: 'success',
            },
          };
        }
        return {
          text: JSON.stringify({
            decision: 'supported',
            reason: 'The diff shows the unguarded path.',
          }),
          tokensUsed: { input: 20, output: 10 },
          modelUsed: 'gpt-5.3-codex',
          providerData,
        };
      });

      const result = await reviewService.__testing.runCliAgenticReviewFastPath({
        reviewType: 'pr_review',
        reviewId: 'pr-candidate',
        projectId: 'proj-1',
        projectPath: testProjectPath,
        providerData,
        providerFailoverState: { candidates: [providerData], preferredIndex: 0 },
        reviewModelConfig: { strategy: 'smart' },
        unavailableModels: new Set(),
        executionModeOrder: ['cli-agentic', 'api'],
        deadline: { check: vi.fn(), signal: null },
        reviewTiming,
        emitProgress: vi.fn(),
        emitHeartbeat,
        markModelUsed: vi.fn(),
        fileHintsInput: [
          { path: 'src/a.ts', status: 'M', reviewSizeHint: 120 },
        ],
        ignorePatterns: [],
        branchName: 'feature/pr-fast-path-candidate',
        baseBranch: 'main',
        mergeBaseSha: 'base123',
        headSha: 'head456',
        totalAdditions: 10,
        totalDeletions: 2,
        qualityMode: 'v2',
        diffLoader: vi.fn().mockResolvedValue([
          'diff --git a/src/a.ts b/src/a.ts',
          '--- a/src/a.ts',
          '+++ b/src/a.ts',
          '@@ -12,1 +12,1 @@',
          '+runWithoutGuard();',
          '',
        ].join('\n')),
        providerCaller,
      });

      expect(result.accepted).toBe(true);
      expect(result.reviewResult?.recommendations).toHaveLength(1);
      expect(result.reviewResult?.recommendations?.[0]).toMatchObject({
        title: 'Candidate issue can be promoted',
        promotedFromCandidate: true,
        verifierDecision: 'supported',
      });
      expect(result.reviewResult?.stats?.candidateFindingPromotion).toMatchObject({
        checked: 1,
        promoted: 1,
        supported: 1,
      });
      expect(providerCaller).toHaveBeenCalledTimes(2);
      expect(emitHeartbeat).toHaveBeenCalledWith('provider_call');
    });

    it('returns structured follow-up fallback for low-coverage PR agentic results', async () => {
      const providerData = {
        provider: {
          id: 'cli-openai',
          type: 'openai',
          model: 'gpt-5.3-codex',
          source: 'cli_detected',
        },
      };
      const reviewTiming = reviewService.__testing.createReviewTiming('pr_review', 'pr-2');
      const fileHintsInput = Array.from({ length: 36 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: 'M',
        reviewSizeHint: 50,
      }));

      const result = await reviewService.__testing.runCliAgenticReviewFastPath({
        reviewType: 'pr_review',
        reviewId: 'pr-2',
        projectId: 'proj-1',
        projectPath: testProjectPath,
        providerData,
        providerFailoverState: { candidates: [providerData], preferredIndex: 0 },
        reviewModelConfig: { strategy: 'smart' },
        unavailableModels: new Set(),
        executionModeOrder: ['cli-agentic', 'api'],
        deadline: { check: vi.fn(), signal: null },
        reviewTiming,
        emitProgress: vi.fn(),
        markModelUsed: vi.fn(),
        fileHintsInput,
        ignorePatterns: [],
        branchName: 'feature/pr-fast-path',
        baseBranch: 'main',
        mergeBaseSha: 'base123',
        headSha: 'head456',
        totalAdditions: 10,
        totalDeletions: 2,
        qualityMode: 'v2',
        diffLoader: vi.fn().mockResolvedValue(''),
        providerCaller: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            summary: 'Low coverage result',
            riskLevel: 'medium',
            changeGroups: [],
            recommendations: [],
            stats: {
              deepReviewedFiles: 3,
              filesAnalyzed: 3,
              totalAdditions: 10,
              totalDeletions: 2,
              estimatedComplexity: 'moderate',
            },
          }),
          tokensUsed: { input: 120, output: 60 },
          modelUsed: 'gpt-5.3-codex',
          providerData,
          agenticMeta: {
            actualTurns: 8,
            completionReason: 'success',
          },
        }),
      });

      expect(result.accepted).toBe(false);
      expect(result.reviewResult).toBeNull();
      expect(result.fallbackMeta).toEqual(expect.objectContaining({
        mode: 'diff_followup',
        reason: 'insufficient_deep_coverage',
      }));
    });

    it('routes CLI reviews with many files to chunked path even when diff is small', () => {
      const shouldChunk = reviewService.__testing.shouldUseChunkedReviewPath(
        { useClaudeCLI: true },
        9000,
        12
      );
      expect(shouldChunk).toBe(true);
    });

    it('allows API single-shot path for small reviews', () => {
      const shouldChunk = reviewService.__testing.shouldUseChunkedReviewPath(
        { provider: { type: 'openai' } },
        9000,
        4
      );
      expect(shouldChunk).toBe(false);
    });

    it('does not classify context-window errors as transient retry candidates', () => {
      const contextErr = new Error('Maximum context length exceeded for this model');
      expect(reviewService.__testing.isLikelyContextWindowError(contextErr)).toBe(true);
      expect(reviewService.__testing.isLikelyTransientProviderError(contextErr)).toBe(false);
      expect(reviewService.__testing.classifyProviderError(contextErr)).toBe('context_window');
    });

    it('classifies model-not-found failures as model_unavailable', () => {
      const modelErr = new Error('Model not found: gpt-5.9-codex');
      expect(reviewService.__testing.isLikelyModelUnavailableError(modelErr)).toBe(true);
      expect(reviewService.__testing.classifyProviderError(modelErr)).toBe('model_unavailable');
      expect(reviewService.__testing.isLikelyTransientProviderError(modelErr)).toBe(false);
    });

    it('retries once with fallback model when preferred model is unavailable', async () => {
      const modelsTried = [];
      const result = await reviewService.__testing.callProviderForReviewWithRetry(
        { provider: { type: 'openai', model: 'gpt-5.4-nano' } },
        'prompt',
        {
          maxRetries: 0,
          modelOverride: 'gpt-5.4-nano',
          fallbackModelOverride: 'gpt-5.3-codex',
          requestExecutor: async (_providerData, _prompt, options) => {
            const activeModel = options.modelOverride || 'unknown';
            modelsTried.push(activeModel);
            if (activeModel === 'gpt-5.4-nano') {
              throw new Error('Model not found: gpt-5.4-nano');
            }
            return {
              text: '{"summary":"ok","riskLevel":"low","changeGroups":[],"recommendations":[],"stats":{"filesAnalyzed":0,"totalAdditions":0,"totalDeletions":0,"estimatedComplexity":"simple"}}',
              tokensUsed: { input: 10, output: 5 },
              modelUsed: activeModel,
            };
          },
        }
      );

      expect(modelsTried).toEqual(['gpt-5.4-nano', 'gpt-5.3-codex']);
      expect(result.modelUsed).toBe('gpt-5.3-codex');
    });

    it('does not loop indefinitely when fallback model is also unavailable', async () => {
      const modelsTried = [];
      await expect(reviewService.__testing.callProviderForReviewWithRetry(
        { provider: { type: 'openai', model: 'gpt-5.4-nano' } },
        'prompt',
        {
          maxRetries: 0,
          modelOverride: 'gpt-5.4-nano',
          fallbackModelOverride: 'gpt-5.3-codex',
          requestExecutor: async (_providerData, _prompt, options) => {
            const activeModel = options.modelOverride || 'unknown';
            modelsTried.push(activeModel);
            throw new Error(`Model not found: ${activeModel}`);
          },
        }
      )).rejects.toThrow(/Model not found/);
      expect(modelsTried).toEqual(['gpt-5.4-nano', 'gpt-5.3-codex']);
    });

    it('honors the user-selected model under smart (Balanced) strategy for review phase', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-sonnet-4-6' } },
        'review',
        { strategy: 'smart' }
      );
      expect(resolved.strategy).toBe('smart');
      expect(resolved.model).toBe('claude-sonnet-4-6');
      expect(resolved.decisionReason).toBe('balanced_user_selected_model');
      expect(resolved.budgetClass).toBe('balanced');
      expect(resolved.fallback).toBe(false);
    });

    it('honors the user-selected model under performance strategy for review phase', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-sonnet-4-6' } },
        'review',
        { strategy: 'performance' }
      );
      expect(resolved.strategy).toBe('performance');
      expect(resolved.effectiveStrategy).toBe('performance');
      expect(resolved.model).toBe('claude-sonnet-4-6');
      expect(resolved.decisionReason).toBe('performance_user_selected_model');
      expect(resolved.budgetClass).toBe('balanced');
      expect(resolved.fallback).toBe(false);
    });

    it('honors the user-selected model under smart strategy for verifier phase', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        'verifier',
        { strategy: 'smart' }
      );
      expect(resolved.phase).toBe('verifier');
      expect(resolved.model).toBe('gpt-5.3-codex');
      expect(resolved.strategy).toBe('smart');
      expect(resolved.decisionReason).toBe('balanced_user_selected_model');
    });

    it('honors user-selected Gemini model under smart strategy for review phase', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        {
          provider: { type: 'google', model: 'gemini-3.1-pro-preview', source: 'cli_detected' },
          useGeminiCLI: true,
        },
        'review',
        { strategy: 'smart' },
      );

      expect(resolved.phase).toBe('review');
      expect(resolved.strategy).toBe('smart');
      expect(resolved.model).toBe('gemini-3.1-pro-preview');
      expect(resolved.decisionReason).toBe('balanced_user_selected_model');
    });

    it('honors detected Codex CLI model under smart strategy for review phase', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        {
          provider: { type: 'openai', model: 'gpt-5.5', source: 'cli_detected' },
          useCodexCLI: true,
        },
        'review',
        { strategy: 'smart' },
      );

      expect(resolved.phase).toBe('review');
      expect(resolved.strategy).toBe('smart');
      expect(resolved.model).toBe('gpt-5.5');
      expect(resolved.decisionReason).toBe('balanced_user_selected_model');
    });

    it('keeps OpenAI CLI smart triage and walkthrough on cheaper CLI defaults', () => {
      const providerData = {
        provider: { type: 'openai', model: 'gpt-5.4', source: 'cli_detected' },
        useCodexCLI: true,
      };

      const triage = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'triage',
        { strategy: 'smart' },
      );
      const walkthrough = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'walkthrough',
        { strategy: 'smart' },
      );
      const review = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        { strategy: 'smart' },
      );

      expect(triage.model).toBe('gpt-5.3-codex');
      expect(walkthrough.model).toBe('gpt-5.3-codex');
      expect(review.model).toBe('gpt-5.4');
    });

    it('keeps smart strategy on the user-selected model regardless of risk hints', () => {
      const lowRisk = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-sonnet-4-6' } },
        'review',
        { strategy: 'smart' },
        {
          fileCount: 6,
          diffChars: 9000,
          focusedReview: true,
          riskFlags: {},
        }
      );
      expect(lowRisk.model).toBe('claude-sonnet-4-6');
      expect(lowRisk.decisionReason).toBe('balanced_user_selected_model');
      expect(lowRisk.budgetClass).toBe('balanced');

      const highRisk = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-sonnet-4-6' } },
        'review',
        { strategy: 'smart' },
        {
          fileCount: 6,
          diffChars: 9000,
          focusedReview: true,
          riskFlags: { dependencyChanges: true },
        }
      );
      expect(highRisk.model).toBe('claude-sonnet-4-6');
      expect(highRisk.decisionReason).toBe('balanced_user_selected_model');
      expect(highRisk.budgetClass).toBe('balanced');
      expect(highRisk.decisionInputs.highRiskHints).toBe(true);
    });

    it('keeps walkthrough cheap but upgrades smart triage to a review-capable model', () => {
      const providerData = { provider: { type: 'anthropic', model: 'claude-sonnet-4-6' } };
      const triage = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'triage',
        { strategy: 'smart' },
      );
      const walkthrough = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'walkthrough',
        { strategy: 'smart' },
      );

      expect(triage.model).toBe('claude-sonnet-4-6');
      expect(triage.decisionReason).toBe('smart_triage_default');
      expect(triage.fallback).toBe(true);
      expect(triage.fallbackReason).toBe('model_blocked_unreliable_json');
      expect(triage.budgetClass).toBe('balanced');
      expect(walkthrough.model).toBe('claude-haiku-4-5-20251001');
      expect(walkthrough.decisionReason).toBe('smart_walkthrough_default');
      expect(walkthrough.budgetClass).toBe('latency');
    });

    it('swaps Haiku to a review-capable model when user selects it for the review phase', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-haiku-4-5-20251001' } },
        'review',
        { strategy: 'smart' }
      );

      expect(resolved.model).not.toBe('claude-haiku-4-5-20251001');
      expect(resolved.fallback).toBe(true);
      expect(resolved.fallbackReason).toBe('model_blocked_unreliable_json');
    });

    it('keeps Haiku for walkthrough phase (exempt from review-capable guard)', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-haiku-4-5-20251001' } },
        'walkthrough',
        { strategy: 'smart' }
      );

      // Smart walkthrough uses smartModel || providerModel. smartModel for
      // walkthrough is Haiku itself, so the result is Haiku, not swapped.
      expect(resolved.model).toBe('claude-haiku-4-5-20251001');
      expect(resolved.fallback).toBe(false);
    });

    it('falls back to a known model when smart strategy candidate is unsupported', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-some-retired-snapshot' } },
        'review',
        { strategy: 'smart' }
      );

      expect(resolved.fallback).toBe(true);
      expect(resolved.fallbackReason).toBe('smart_model_unavailable');
      expect(resolved.decisionReason).toBe('smart_model_unavailable');
      expect(resolved.model).not.toBe('claude-some-retired-snapshot');
      expect(typeof resolved.model).toBe('string');
      expect(resolved.model.length).toBeGreaterThan(0);
    });

    it('honors user-selected review model when adaptive rollout is disabled', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-sonnet-4-6' } },
        'review',
        {
          strategy: 'adaptive',
          rollout: { mode: 'off' },
        }
      );

      expect(resolved.strategy).toBe('adaptive');
      expect(resolved.effectiveStrategy).toBe('smart');
      expect(resolved.model).toBe('claude-sonnet-4-6');
      expect(resolved.decisionReason).toBe('rollout_off');
    });

    it('routes max_quality strategy explicitly with deterministic decision reason', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-opus-4-6' } },
        'triage',
        { strategy: 'max_quality' }
      );

      expect(resolved.strategy).toBe('max_quality');
      expect(resolved.model).toBe('claude-opus-4-6');
      expect(resolved.budgetClass).toBe('quality');
      expect(resolved.decisionReason).toBe('max_quality_all_phases');
    });

    it('routes latency_first strategy to fast model for low-risk review paths', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        'review',
        { strategy: 'latency_first' },
        {
          fileCount: 4,
          diffChars: 8000,
          riskFlags: {},
        }
      );

      expect(resolved.strategy).toBe('latency_first');
      expect(resolved.model).toBe('gpt-5.5');
      expect(resolved.fallback).toBe(true);
      expect(resolved.fallbackReason).toBe('model_blocked_unreliable_json');
      expect(resolved.budgetClass).toBe('balanced');
      expect(resolved.decisionReason).toBe('latency_first_fast_path');
    });

    it('keeps latency_first strategy on quality model when high-risk hints are present', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-opus-4-6' } },
        'review',
        { strategy: 'latency_first' },
        {
          fileCount: 2,
          diffChars: 3000,
          riskFlags: { dependencyChanges: true },
        }
      );

      expect(resolved.strategy).toBe('latency_first');
      expect(resolved.model).toBe('claude-sonnet-4-6');
      expect(resolved.budgetClass).toBe('latency');
      expect(resolved.decisionReason).toBe('latency_first_guardrail_quality_path');
    });

    it('uses latency_first quality guardrail path beyond threshold boundary', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        'review',
        {
          strategy: 'latency_first',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
        },
        {
          fileCount: 13,
          diffChars: 19999,
          riskFlags: {},
        }
      );

      expect(resolved.model).toBe('gpt-5.5');
      expect(resolved.decisionReason).toBe('latency_first_guardrail_quality_path');
    });

    it('returns threshold profile metadata for routing transparency', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 11,
            fastPathMaxDiffChars: 18000,
            preferQualityOnHighRisk: true,
          },
        },
        {
          fileCount: 5,
          diffChars: 4200,
          highRiskHints: false,
        }
      );

      expect(resolved.thresholdProfile).toMatchObject({
        adaptive: {
          fastPathMaxFiles: 11,
          fastPathMaxDiffChars: 18000,
          preferQualityOnHighRisk: true,
        },
        latencyFirst: {
          reviewMaxFiles: 11,
          reviewMaxDiffChars: 18000,
          guardHighRisk: true,
        },
      });
    });

    it('falls back invalid custom model to safe default model', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        'review',
        {
          strategy: 'custom',
          customModels: {
            review: 'gpt-unknown-custom',
          },
        }
      );
      expect(resolved.strategy).toBe('custom');
      expect(resolved.model).toBe('gpt-5.5');
      expect(resolved.fallback).toBe(true);
      expect(resolved.fallbackReason).toBe('custom_model_unavailable');
    });

    it('routes adaptive strategy to cost-aware review model for small low-risk diffs', () => {
      const providerData = {
        provider: {
          type: 'anthropic',
          model: 'claude-opus-4-6',
        },
      };
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
        },
        {
          fileCount: 3,
          diffChars: 6000,
          highRiskHints: false,
        }
      );
      expect(resolved.strategy).toBe('adaptive');
      expect(resolved.model).toBe('claude-sonnet-4-6');
      expect(resolved.fallback).toBe(false);
      expect(resolved.policyVersion).toBe('2026-02-21.routing.v6');
      expect(resolved.decisionInputs.fileCount).toBe(3);
      expect(resolved.decisionInputs.diffChars).toBe(6000);
      expect(resolved.budgetClass).toBe('latency');
    });

    it('routes adaptive strategy to quality-path model when high-risk hints exist', () => {
      const providerData = {
        provider: {
          type: 'openai',
          model: 'gpt-5.3-codex',
        },
      };
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
        },
        {
          fileCount: 2,
          diffChars: 3000,
          riskFlags: { dependencyChanges: true },
        }
      );
      expect(resolved.strategy).toBe('adaptive');
      expect(resolved.model).toBe('gpt-5.5');
      expect(resolved.decisionInputs.highRiskHints).toBe(true);
      expect(resolved.budgetClass).toBe('quality');
    });

    it('treats inferred API/auth/migration/billing paths as high-risk for adaptive routing', () => {
      const providerData = {
        provider: {
          type: 'openai',
          model: 'gpt-5.3-codex',
        },
      };
      const decisionContext = reviewService.__testing.buildRoutingDecisionContext({
        files: [
          { path: 'src/api/auth/session.ts', reviewSizeHint: 1200 },
          { path: 'prisma/migrations/202605061200_add_subscription.sql', reviewSizeHint: 1800 },
          { path: 'src/billing/stripeCheckout.ts', reviewSizeHint: 900 },
        ],
        diffChars: 3900,
        fallbackFileCount: 3,
      });
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
        },
        decisionContext
      );

      expect(decisionContext.riskFlags.publicApiChanges).toBe(true);
      expect(decisionContext.riskFlags.authPermissionChanges).toBe(true);
      expect(decisionContext.riskFlags.dataMigrationChanges).toBe(true);
      expect(decisionContext.riskFlags.billingPaymentChanges).toBe(true);
      expect(resolved.decisionInputs.highRiskHints).toBe(false);
      expect(resolved.decisionInputs.costAwareHighRiskHints).toBe(true);
      expect(resolved.decisionReason).toBe('adaptive_quality_path');
      expect(resolved.model).toBe('gpt-5.5');
    });

    it('treats Atlas review-engine changes as high-risk for adaptive routing', () => {
      const providerData = {
        provider: {
          type: 'anthropic',
          model: 'claude-opus-4-6',
        },
      };
      const decisionContext = reviewService.__testing.buildRoutingDecisionContext({
        files: [
          { path: 'backend/src/services/reviewService.js', reviewSizeHint: 1200 },
          { path: 'backend/src/services/providerService.js', reviewSizeHint: 900 },
          { path: 'backend/src/services/review/riskFlagHeuristics.js', reviewSizeHint: 800 },
          { path: 'frontend/src/components/GlobalSettingsModal.tsx', reviewSizeHint: 700 },
        ],
        diffChars: 2700,
        fallbackFileCount: 3,
      });
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
        },
        decisionContext
      );

      expect(decisionContext.riskFlags.reviewEngineChanges).toBe(true);
      expect(resolved.decisionInputs.highRiskHints).toBe(false);
      expect(resolved.decisionInputs.costAwareHighRiskHints).toBe(true);
      expect(resolved.decisionReason).toBe('adaptive_quality_path');
      expect(resolved.model).toBe('claude-sonnet-4-6');
    });

    it('applies cost-aware quality routing to cli-agentic provider calls', async () => {
      const previousTestProvider = process.env.ATLAS_REVIEW_TEST_PROVIDER;
      process.env.ATLAS_REVIEW_TEST_PROVIDER = '1';
      const reviewTiming = reviewService.__testing.createReviewTiming('branch_review', 'br-adaptive-cli-model');

      try {
        await callProviderForReviewWithFailover(
          {
            candidates: [
              {
                provider: {
                  id: 'anthropic-cli',
                  type: 'anthropic',
                  model: 'claude-sonnet-4-6',
                },
                useClaudeCLI: true,
              },
            ],
          },
          'prompt',
          {
            maxRetries: 0,
            reviewTiming,
            reviewModelConfig: {
              strategy: 'adaptive',
              adaptive: {
                fastPathMaxFiles: 12,
                fastPathMaxDiffChars: 20000,
                preferQualityOnHighRisk: true,
              },
            },
            modelDecisionContext: {
              reviewExecutionMode: 'cli-agentic',
              fileCount: 10,
              diffChars: 12000,
              riskFlags: { reviewEngineChanges: true },
            },
          }
        );
      } finally {
        if (previousTestProvider === undefined) {
          delete process.env.ATLAS_REVIEW_TEST_PROVIDER;
        } else {
          process.env.ATLAS_REVIEW_TEST_PROVIDER = previousTestProvider;
        }
      }

      expect(reviewTiming.providerAttempts).toHaveLength(1);
      expect(reviewTiming.providerAttempts[0].model).toBe('claude-sonnet-4-6');
    });

    it('treats failing check signals as high-risk for adaptive routing', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-opus-4-6' } },
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
        },
        {
          fileCount: 2,
          diffChars: 3000,
          riskFlags: { hasGitHubCheckFailures: true },
        }
      );

      expect(resolved.decisionInputs.highRiskHints).toBe(false);
      expect(resolved.decisionInputs.costAwareHighRiskHints).toBe(true);
      expect(resolved.decisionReason).toBe('adaptive_quality_path');
      expect(resolved.model).toBe('claude-sonnet-4-6');
    });

    it('uses fast-path at threshold boundary and switches to quality-path above boundary', () => {
      const providerData = {
        provider: {
          type: 'openai',
          model: 'gpt-5.3-codex',
        },
      };
      const adaptiveConfig = {
        strategy: 'adaptive',
        adaptive: {
          fastPathMaxFiles: 12,
          fastPathMaxDiffChars: 20000,
          preferQualityOnHighRisk: true,
        },
      };

      const atThreshold = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        adaptiveConfig,
        {
          fileCount: 12,
          diffChars: 20000,
          highRiskHints: false,
        }
      );
      const aboveFileThreshold = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        adaptiveConfig,
        {
          fileCount: 13,
          diffChars: 20000,
          highRiskHints: false,
        }
      );
      const aboveDiffThreshold = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        adaptiveConfig,
        {
          fileCount: 12,
          diffChars: 20001,
          highRiskHints: false,
        }
      );

      expect(atThreshold.model).toBe('gpt-5.3-codex');
      expect(atThreshold.fallback).toBe(false);
      expect(atThreshold.fallbackReason).toBeNull();
      expect(aboveFileThreshold.model).toBe('gpt-5.5');
      expect(aboveDiffThreshold.model).toBe('gpt-5.5');
    });

    it('marks adaptive model selection as fallback when provider type does not expose known smart models', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'custom-provider', model: 'custom-model-v1' } },
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
        },
        {
          fileCount: 2,
          diffChars: 1000,
          highRiskHints: false,
        }
      );

      expect(resolved.fallback).toBe(true);
      expect(resolved.fallbackReason).toBe('adaptive_model_unavailable');
      expect(resolved.model).toBe('custom-model-v1');
    });

    it('disables adaptive routing when rollout mode is off', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
          rollout: {
            mode: 'off',
            canaryPercent: 25,
            projectAllowlist: [],
          },
        },
        {
          fileCount: 2,
          diffChars: 1200,
          projectId: 'project-off',
          reviewType: 'changeset',
          reviewId: 'cs-off',
        }
      );

      expect(resolved.strategy).toBe('adaptive');
      expect(resolved.effectiveStrategy).toBe('smart');
      expect(resolved.decisionReason).toBe('rollout_off');
      // Adaptive rollout-disabled falls back to smart, which now honors the
      // user-selected model for review-class phases.
      expect(resolved.model).toBe('gpt-5.3-codex');
      expect(resolved.rollout.mode).toBe('off');
      expect(resolved.rollout.enabled).toBe(false);
    });

    it('gates adaptive routing deterministically in canary mode', () => {
      const context = {
        projectId: 'project-canary',
        reviewType: 'branch_review',
        reviewId: 'br-canary-1',
        fileCount: 2,
        diffChars: 1200,
      };
      const bucketA = reviewService.__testing.computeStableRolloutBucket('project-canary|branch_review|br-canary-1|2|1200');
      const bucketB = reviewService.__testing.computeStableRolloutBucket('project-canary|branch_review|br-canary-1|2|1200');
      expect(bucketA).toBe(bucketB);

      const skipped = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-opus-4-6' } },
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
          rollout: {
            mode: 'canary',
            canaryPercent: 0,
            projectAllowlist: [],
          },
        },
        context
      );
      expect(skipped.rollout.enabled).toBe(false);
      expect(skipped.decisionReason).toBe('rollout_canary_skipped');

      const selected = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-opus-4-6' } },
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
          rollout: {
            mode: 'canary',
            canaryPercent: 100,
            projectAllowlist: [],
          },
        },
        context
      );
      expect(selected.rollout.enabled).toBe(true);
      expect(selected.decisionReason).toBe('adaptive_fast_path');
      expect(selected.model).toBe('claude-sonnet-4-6');
    });

    it('uses smart fallback when adaptive rollout allowlist does not include project', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'anthropic', model: 'claude-opus-4-6' } },
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
          rollout: {
            mode: 'on',
            canaryPercent: 25,
            projectAllowlist: ['project-a', 'project-b'],
          },
        },
        {
          projectId: 'project-z',
          reviewType: 'changeset',
          reviewId: 'cs-123',
          fileCount: 1,
          diffChars: 400,
        }
      );
      expect(resolved.rollout.allowlistEnabled).toBe(true);
      expect(resolved.rollout.allowlistMatched).toBe(false);
      expect(resolved.effectiveStrategy).toBe('smart');
      expect(resolved.decisionReason).toBe('rollout_allowlist_excluded');
      // Adaptive rollout-disabled falls back to smart, which now honors the
      // user-selected model for review-class phases.
      expect(resolved.model).toBe('claude-opus-4-6');
    });

    it('forces smart fallback when adaptive rollout gate status is fail', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
          rollout: {
            mode: 'on',
            canaryPercent: 100,
            projectAllowlist: [],
            gate: {
              status: 'fail',
              reasonCodes: ['gate_partial_review'],
              source: 'harness',
            },
          },
        },
        {
          projectId: 'project-gate-fail',
          reviewType: 'branch_review',
          reviewId: 'br-gate-fail',
          fileCount: 2,
          diffChars: 3000,
          highRiskHints: false,
        }
      );

      expect(resolved.effectiveStrategy).toBe('smart');
      expect(resolved.decisionReason).toBe('rollout_gate_failed');
      expect(resolved.fallback).toBe(true);
      expect(resolved.fallbackReason).toBe('rollout_gate_failed');
      expect(resolved.rollout.enabled).toBe(false);
      expect(resolved.rollout.gate.status).toBe('fail');
    });

    it('holds adaptive routing behind smart fallback when rollout gate status is warn in on mode', () => {
      const resolved = reviewService.__testing.resolveEffectiveReviewModel(
        { provider: { type: 'openai', model: 'gpt-5.3-codex' } },
        'review',
        {
          strategy: 'adaptive',
          adaptive: {
            fastPathMaxFiles: 12,
            fastPathMaxDiffChars: 20000,
            preferQualityOnHighRisk: true,
          },
          rollout: {
            mode: 'on',
            canaryPercent: 100,
            projectAllowlist: [],
            gate: {
              status: 'warn',
              reasonCodes: ['gate_first_signal_slow'],
              source: 'harness',
            },
          },
        },
        {
          projectId: 'project-gate-warn',
          reviewType: 'branch_review',
          reviewId: 'br-gate-warn',
          fileCount: 2,
          diffChars: 3000,
          highRiskHints: false,
        }
      );

      expect(resolved.effectiveStrategy).toBe('smart');
      expect(resolved.decisionReason).toBe('rollout_gate_warn');
      expect(resolved.fallback).toBe(true);
      expect(resolved.fallbackReason).toBe('rollout_gate_warn');
      expect(resolved.rollout.enabled).toBe(false);
      expect(resolved.rollout.gate.status).toBe('warn');
    });

    it('evaluates per-run review gate outcomes with deterministic reason codes', () => {
      const failGate = reviewService.__testing.evaluateReviewRunGate({
        stats: {
          totalChangedFiles: 40,
          deepReviewedFiles: 18,
          omittedFiles: 22,
          isPartial: true,
        },
        timing: {
          totalMs: 0,
          firstSignalMs: null,
        },
      });
      expect(failGate.status).toBe('fail');
      expect(failGate.reasonCodes).toContain('gate_partial_review');
      expect(failGate.reasonCodes).toContain('gate_telemetry_missing_duration');
      expect(failGate.reasonCodes).toContain('gate_telemetry_missing_first_signal');
      expect(failGate.reasonCodes).toContain('gate_deep_coverage_below_floor');

      const warnGate = reviewService.__testing.evaluateReviewRunGate({
        stats: {
          totalChangedFiles: 20,
          deepReviewedFiles: 17,
          omittedFiles: 3,
          isPartial: false,
        },
        timing: {
          totalMs: 120000,
          firstSignalMs: 110000,
        },
      });
      expect(warnGate.status).toBe('warn');
      expect(warnGate.reasonCodes).toContain('gate_first_signal_slow');
      expect(warnGate.reasonCodes).not.toContain('gate_deep_coverage_below_floor');

      const passGate = reviewService.__testing.evaluateReviewRunGate({
        stats: {
          totalChangedFiles: 20,
          deepReviewedFiles: 17,
          omittedFiles: 3,
          isPartial: false,
        },
        timing: {
          totalMs: 90000,
          firstSignalMs: 30000,
        },
      });
      expect(passGate.status).toBe('pass');
      expect(passGate.reasonCodes).toEqual([]);

      const precisionFailGate = reviewService.__testing.evaluateReviewRunGate({
        stats: {
          totalChangedFiles: 20,
          deepReviewedFiles: 19,
          omittedFiles: 1,
          isPartial: false,
          issuesTotal: 10,
          issuesGrounded: 4,
          issuesDemoted: 4,
          issuesSuppressed: 2,
          verifierSupported: 2,
          verifierUnsupported: 6,
          verifierNeedsMoreContext: 0,
          reviewOutcomeTelemetry: {
            issueTotal: 10,
            issueDismissed: 8,
            issueAddressed: 2,
          },
        },
        timing: {
          totalMs: 80000,
          firstSignalMs: 20000,
        },
      });
      expect(precisionFailGate.status).toBe('fail');
      expect(precisionFailGate.reasonCodes).toContain('gate_precision_unsupported_issue_rate_high');
      expect(precisionFailGate.reasonCodes).toContain('gate_precision_low_evidence_issue_rate_high');
      expect(precisionFailGate.reasonCodes).toContain('gate_precision_dismissed_issue_rate_high');

      const corroborationGate = reviewService.__testing.evaluateReviewRunGate({
        stats: {
          totalChangedFiles: 14,
          deepReviewedFiles: 14,
          omittedFiles: 0,
          isPartial: false,
          corroborationChecked: 10,
          corroborationUnsupported: 9,
          outcomeSuppressionCandidates: 10,
          outcomeSuppressionSuppressed: 9,
        },
        timing: {
          totalMs: 60000,
          firstSignalMs: 10000,
        },
      });
      expect(corroborationGate.status).toBe('fail');
      expect(corroborationGate.reasonCodes).toContain('gate_precision_uncorroborated_high_risk_rate_high');
      expect(corroborationGate.reasonCodes).toContain('gate_precision_outcome_suppression_rate_high');

      const precisionPassGate = reviewService.__testing.evaluateReviewRunGate({
        stats: {
          totalChangedFiles: 12,
          deepReviewedFiles: 12,
          omittedFiles: 0,
          isPartial: false,
          issuesTotal: 10,
          issuesGrounded: 9,
          issuesDemoted: 1,
          issuesSuppressed: 0,
          verifierSupported: 8,
          verifierUnsupported: 1,
          verifierNeedsMoreContext: 1,
          reviewOutcomeTelemetry: {
            issueTotal: 10,
            issueDismissed: 2,
            issueAddressed: 8,
          },
        },
        timing: {
          totalMs: 80000,
          firstSignalMs: 20000,
        },
      });
      expect(precisionPassGate.status).toBe('pass');
      expect(precisionPassGate.reasonCodes).toEqual([]);
    });

    it('classifies runtime errors with deterministic retry gating (table-driven)', () => {
      const deadlineErr = new Error('Review deadline exceeded (300s)');
      deadlineErr.isDeadline = true;
      const timeoutCodeErr = new Error('');
      timeoutCodeErr.code = 'ETIMEDOUT';
      const networkCodeErr = new Error('');
      networkCodeErr.code = 'ECONNRESET';

      const cases = [
        {
          label: 'provider timeout message',
          error: new Error('OpenAI request timed out after 60 seconds'),
          expectedRuntimeClass: 'timeout',
          expectedLegacyClass: 'timeout',
          expectedRetryable: true,
          expectedTransient: true,
        },
        {
          label: 'deadline guard abort',
          error: deadlineErr,
          expectedRuntimeClass: 'timeout',
          expectedLegacyClass: 'deadline',
          expectedRetryable: false,
          expectedTransient: false,
        },
        {
          label: 'explicit timeout runtime code',
          error: timeoutCodeErr,
          expectedRuntimeClass: 'timeout',
          expectedLegacyClass: 'timeout',
          expectedRetryable: true,
          expectedTransient: true,
        },
        {
          label: 'network reset runtime code',
          error: networkCodeErr,
          expectedRuntimeClass: 'transient',
          expectedLegacyClass: 'network',
          expectedRetryable: true,
          expectedTransient: true,
        },
        {
          label: 'auth runtime classification',
          error: reviewService.__testing.createReviewRuntimeError('Invalid API key', 'auth'),
          expectedRuntimeClass: 'auth',
          expectedLegacyClass: 'auth',
          expectedRetryable: false,
          expectedTransient: false,
        },
        {
          label: 'context window runtime classification',
          error: reviewService.__testing.createReviewRuntimeError('Context too large', 'context_limit'),
          expectedRuntimeClass: 'context_limit',
          expectedLegacyClass: 'context_window',
          expectedRetryable: false,
          expectedTransient: false,
        },
        {
          label: 'invalid request runtime classification',
          error: reviewService.__testing.createReviewRuntimeError('Bad request payload', 'bad_request'),
          expectedRuntimeClass: 'invalid_request',
          expectedLegacyClass: 'invalid_request',
          expectedRetryable: false,
          expectedTransient: false,
        },
      ];

      for (const testCase of cases) {
        const runtimeClass = reviewService.__testing.classifyReviewRuntimeError(testCase.error);
        expect(runtimeClass.runtimeClass, testCase.label).toBe(testCase.expectedRuntimeClass);
        expect(runtimeClass.retryable, testCase.label).toBe(testCase.expectedRetryable);
        expect(reviewService.__testing.classifyProviderError(testCase.error), testCase.label).toBe(testCase.expectedLegacyClass);
        expect(reviewService.__testing.isLikelyTransientProviderError(testCase.error), testCase.label).toBe(testCase.expectedTransient);
      }
    });

    it('tags persisted terminal metadata with deterministic runtime class markers', () => {
      const cases = [
        {
          label: 'deadline tagging',
          error: new Error('Review deadline exceeded (300s)'),
          failureClass: 'deadline',
          expectedTag: '[class=deadline]',
        },
        {
          label: 'timeout tagging',
          error: new Error('Provider timeout while streaming'),
          failureClass: 'timeout',
          expectedTag: '[class=timeout]',
        },
        {
          label: 'auth tagging',
          error: new Error('Invalid API key'),
          failureClass: 'auth',
          expectedTag: '[class=auth]',
        },
        {
          label: 'unknown class keeps base message untagged',
          error: new Error('Unknown provider failure'),
          failureClass: 'unknown',
          expectedTag: null,
        },
      ];

      for (const testCase of cases) {
        const message = reviewService.__testing.buildPersistedReviewErrorMessage(testCase.error, {
          failureClass: testCase.failureClass,
          providerAttempts: [],
        });

        if (testCase.expectedTag) {
          expect(message, testCase.label).toContain(testCase.expectedTag);
        } else {
          expect(message, testCase.label).not.toMatch(/\[class=[^\]]+\]/i);
        }
      }
    });

    it('normalizes timeout env values through bounded integer parsing', () => {
      const key = 'ATLAS_TEST_REVIEW_TIMEOUT';
      const previous = process.env[key];
      try {
        process.env[key] = 'not-a-number';
        expect(reviewService.__testing.parseEnvInteger(key, 5000, { min: 1000, max: 9000 })).toBe(5000);

        process.env[key] = '-100';
        expect(reviewService.__testing.parseEnvInteger(key, 5000, { min: 1000, max: 9000 })).toBe(1000);

        process.env[key] = '12000';
        expect(reviewService.__testing.parseEnvInteger(key, 5000, { min: 1000, max: 9000 })).toBe(9000);
      } finally {
        if (previous === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous;
        }
      }
    });

    it('annotates partial reviews with chunk stats and non-low default risk when no chunks complete', () => {
      const payload = {
        review: {
          summary: 'Initial summary.',
          riskLevel: 'low',
          changeGroups: [],
          recommendations: [],
          stats: {},
        },
        tokensUsed: { input: 0, output: 0 },
      };

      const result = reviewService.__testing.annotatePartialReview(payload, {
        completedChunks: 0,
        totalChunks: 6,
        errorMessage: 'Review deadline exceeded (300s)',
        errorClass: 'deadline',
      });

      expect(result.review.stats.isPartial).toBe(true);
      expect(result.review.stats.partialChunksCompleted).toBe(0);
      expect(result.review.stats.partialChunksTotal).toBe(6);
      expect(result.review.stats.partialReason).toContain('deadline exceeded');
      expect(result.review.stats.partialReason).toContain('[class=deadline]');
      expect(result.review.summary).toContain('Partial review: analyzed 0/6 chunk(s)');
      expect(result.review.riskLevel).toBe('medium');
    });

    it('builds deadline partial aggregate with deterministic partial metadata', () => {
      const aggregate = reviewService.__testing.buildDeadlinePartialAggregate({
        fallbackSummary: 'Timed out before completion.',
        fileCount: 12,
        totalFileCount: 20,
        focusedFileCount: 12,
        omittedFileCount: 8,
        filePaths: ['src/a.ts', 'src/b.ts'],
        totalAdditions: 120,
        totalDeletions: 40,
        totalChunks: 4,
        errorMessage: 'Review deadline exceeded (300s)',
        errorClass: 'deadline',
      });

      expect(aggregate.review.stats.isPartial).toBe(true);
      expect(aggregate.review.stats.partialChunksCompleted).toBe(0);
      expect(aggregate.review.stats.partialChunksTotal).toBe(4);
      expect(aggregate.review.stats.partialReason).toContain('deadline exceeded');
      expect(aggregate.review.stats.partialReason).toContain('[class=deadline]');
      reviewService.__testing.assignReviewTier(aggregate.review);
      expect(aggregate.review.stats.reviewTier).toBe('partial');
    });

    it('builds persisted failure reason with provider attempt chain', () => {
      const error = new Error('Review deadline exceeded (300s)');
      error.isDeadline = true;
      const message = reviewService.__testing.buildPersistedReviewErrorMessage(error, {
        failureClass: 'deadline',
        providerAttempts: [
          {
            providerType: 'openai',
            model: 'gpt-5.3-codex',
            mode: 'openai_api',
            outcome: 'failed_failover',
            errorClass: 'timeout',
          },
          {
            providerType: 'anthropic',
            model: 'claude-sonnet-4-6',
            mode: 'anthropic_api',
            outcome: 'failed',
            errorClass: 'deadline',
          },
        ],
      });

      expect(message).toContain('[class=deadline]');
      expect(message).toContain('openai/gpt-5.3-codex');
      expect(message).toContain('anthropic/claude-sonnet-4-6');
      expect(message).toContain('Attempts:');
    });

    it('derives a persisted partial review error when coverage is incomplete', () => {
      const persisted = reviewService.__testing.derivePersistedReviewErrorFromResult({
        summary: 'Partial output available.',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [],
        stats: {
          reviewTier: 'partial',
          isPartial: true,
          partialChunksCompleted: 2,
          partialChunksTotal: 5,
          partialReason: 'Review deadline exceeded (300s)',
        },
      });
      expect(persisted).toContain('Partial review');
      expect(persisted).toContain('2/5 chunk(s)');
      expect(persisted).toContain('deadline');
      expect(persisted).toContain('[class=deadline]');
    });

    it('clears stale PR review payload fields when persisting a failed rerun', () => {
      const payload = reviewService.__testing.buildPrReviewTerminalUpdatePayload({
        reviewStatus: 'failed',
        reviewError: 'OpenCode CLI-agentic timed out after 538 seconds [class=timeout]',
      });

      expect(payload).toMatchObject({
        review_status: 'failed',
        review_error: 'OpenCode CLI-agentic timed out after 538 seconds [class=timeout]',
        review_risk_level: null,
        review_summary: null,
        review_json: null,
        review_head_sha: null,
        reviewed_at: null,
      });
    });

    it('keeps explicit failed PR review payload fields when provided', () => {
      const payload = reviewService.__testing.buildPrReviewTerminalUpdatePayload({
        reviewStatus: 'failed',
        reviewRiskLevel: 'medium',
        reviewSummary: 'Partial failure summary.',
        reviewJson: '{"partial":true}',
        reviewError: 'Partial review failed',
        reviewHeadSha: 'abc123',
        reviewedAt: '2026-04-29T00:00:00.000Z',
      });

      expect(payload).toMatchObject({
        review_status: 'failed',
        review_risk_level: 'medium',
        review_summary: 'Partial failure summary.',
        review_json: '{"partial":true}',
        review_error: 'Partial review failed',
        review_head_sha: 'abc123',
        reviewed_at: '2026-04-29T00:00:00.000Z',
      });
    });

    it('orders OpenCode chunk files by code risk before low-signal files', () => {
      const ordered = reviewService.__testing.prioritizeReviewFilesForChunking([
        { path: 'docs/release-notes.md', status: 'M', profileClass: 'shallow' },
        { path: 'Project_BLACK/BLACK_Unity/Assets/BLACK/Missions/Scripts/CombatObjective/ObjectiveTracker.cs', status: 'M', profileClass: 'deep' },
        { path: 'Project_BLACK/BLACK_Unity/Assets/BLACK/Missions/Prefabs/Objective.prefab', status: 'M', profileClass: 'structural' },
      ], {
        useOpenCodeCLI: true,
        provider: { type: 'opencode' },
      });

      expect(ordered.map((file) => file.path)).toEqual([
        'Project_BLACK/BLACK_Unity/Assets/BLACK/Missions/Scripts/CombatObjective/ObjectiveTracker.cs',
        'Project_BLACK/BLACK_Unity/Assets/BLACK/Missions/Prefabs/Objective.prefab',
        'docs/release-notes.md',
      ]);
    });

    it('preserves file metadata when scoring OpenCode chunk priority', () => {
      const reviewProfile = {
        classifyEntry: (entry) => ({
          fileClass: Number(entry.additions || 0) > 100 ? 'deep' : 'shallow',
          reason: 'test_metadata_sensitive',
          pairWithSiblingMeta: false,
          riskBoost: Number(entry.additions || 0) > 100 ? 600 : 0,
          sizeMultiplier: 1,
        }),
      };

      const ordered = reviewService.__testing.prioritizeReviewFilesForChunking([
        { path: 'src/minor.js', status: 'M', profileClass: 'shallow', additions: 1, deletions: 0 },
        { path: 'src/high-churn.js', status: 'M', profileClass: 'shallow', additions: 240, deletions: 12 },
      ], {
        useOpenCodeCLI: true,
        provider: { type: 'opencode' },
      }, {
        reviewProfile,
      });

      expect(ordered.map((file) => file.path)).toEqual([
        'src/high-churn.js',
        'src/minor.js',
      ]);
    });

    it('stops OpenCode chunk scheduling under deadline pressure after useful chunks complete', () => {
      const stop = reviewService.__testing.resolveChunkDeadlinePressureStop({
        providerData: {
          useOpenCodeCLI: true,
          provider: { type: 'opencode' },
        },
        deadline: {
          remainingMs: () => 45000,
        },
        chunkState: {
          chunkReviews: [{ review: { summary: 'done' } }],
        },
        nextChunkIndex: 5,
        totalChunks: 8,
        thresholdMs: 90000,
      });

      expect(stop).toMatchObject({
        reason: 'deadline_pressure',
        remainingMs: 45000,
        thresholdMs: 90000,
        completedChunks: 1,
        nextChunkIndex: 5,
        totalChunks: 8,
      });
      expect(stop.message).toContain('Stopped before starting chunk 5/8');
    });

    it('stops non-OpenCode CLI chunk scheduling under deadline pressure after useful chunks complete', () => {
      const stop = reviewService.__testing.resolveChunkDeadlinePressureStop({
        providerData: {
          useClaudeCLI: true,
          provider: { type: 'anthropic' },
        },
        deadline: {
          remainingMs: () => 45000,
        },
        chunkState: {
          chunkReviews: [{ review: { summary: 'done' } }],
        },
        nextChunkIndex: 3,
        totalChunks: 6,
        thresholdMs: 90000,
      });

      expect(stop).toMatchObject({
        reason: 'deadline_pressure',
        remainingMs: 45000,
        thresholdMs: 90000,
        completedChunks: 1,
        nextChunkIndex: 3,
        totalChunks: 6,
      });
      expect(stop.message).toContain('Stopped before starting chunk 3/6');
    });

    it('does not stop direct API chunk scheduling under deadline pressure', () => {
      const stop = reviewService.__testing.resolveChunkDeadlinePressureStop({
        providerData: {
          apiKey: 'sk-test',
          provider: { type: 'anthropic' },
        },
        deadline: {
          remainingMs: () => 1000,
        },
        chunkState: {
          chunkReviews: [{ review: { summary: 'done' } }],
        },
        nextChunkIndex: 2,
        totalChunks: 6,
        thresholdMs: 90000,
      });

      expect(stop).toBeNull();

      const openCodeApiStop = reviewService.__testing.resolveChunkDeadlinePressureStop({
        providerData: {
          apiKey: 'sk-test',
          provider: { type: 'opencode' },
        },
        deadline: {
          remainingMs: () => 1000,
        },
        chunkState: {
          chunkReviews: [{ review: { summary: 'done' } }],
        },
        nextChunkIndex: 2,
        totalChunks: 6,
        thresholdMs: 90000,
      });

      expect(openCodeApiStop).toBeNull();
    });

    it('annotates OpenCode deadline-pressure partial reviews as skipped chunks', () => {
      const payload = {
        review: {
          summary: 'Reviewed priority files.',
          riskLevel: 'low',
          changeGroups: [],
          recommendations: [],
          stats: {},
        },
        tokensUsed: { input: 0, output: 0 },
      };

      const result = reviewService.__testing.annotatePartialReview(payload, {
        completedChunks: 4,
        totalChunks: 8,
        errorMessage: 'Stopped before starting chunk 5/8',
        errorClass: 'deadline',
        remainingChunkStatus: 'skipped',
      });

      expect(result.review.summary).toContain('Partial review: analyzed 4/8 chunk(s)');
      expect(result.review.summary).toContain('Remaining chunks were skipped');
      expect(result.review.summary).not.toContain('Remaining chunks failed');
    });

    it('does not stop OpenCode chunk scheduling before any chunk completes', () => {
      const stop = reviewService.__testing.resolveChunkDeadlinePressureStop({
        providerData: {
          useOpenCodeCLI: true,
          provider: { type: 'opencode' },
        },
        deadline: {
          remainingMs: () => 1000,
        },
        chunkState: {
          chunkReviews: [],
        },
        nextChunkIndex: 1,
        totalChunks: 8,
        thresholdMs: 90000,
      });

      expect(stop).toBeNull();
    });

    it('raises OpenCode chunk stop threshold from observed slow chunk duration', () => {
      const stop = reviewService.__testing.resolveChunkDeadlinePressureStop({
        providerData: {
          useOpenCodeCLI: true,
          provider: { type: 'opencode' },
        },
        deadline: {
          remainingMs: () => 131000,
        },
        chunkState: {
          chunkReviews: [{ review: { summary: 'slow priority chunk complete' } }],
          chunkDurationsMs: [155000],
        },
        nextChunkIndex: 2,
        totalChunks: 6,
        totalReviewFiles: 47,
        thresholdMs: 120000,
      });

      expect(stop).toMatchObject({
        reason: 'deadline_pressure',
        remainingMs: 131000,
        staticThresholdMs: 120000,
        dynamicThresholdMs: 223750,
        tierReferenceMs: 150000,
        observedP75Ms: 155000,
      });
      expect(stop.thresholdMs).toBe(223750);
      expect(stop.message).toContain('Stopped before starting chunk 2/6');
    });

    it('keeps reviewing OpenCode chunks when observed chunk duration is below the static floor', () => {
      const stop = reviewService.__testing.resolveChunkDeadlinePressureStop({
        providerData: {
          useOpenCodeCLI: true,
          provider: { type: 'opencode' },
        },
        deadline: {
          remainingMs: () => 131000,
        },
        chunkState: {
          chunkReviews: [{ review: { summary: 'fast chunk complete' } }],
          chunkDurationsMs: [35000],
        },
        nextChunkIndex: 2,
        totalChunks: 6,
        totalReviewFiles: 47,
        thresholdMs: 120000,
      });

      expect(stop).toBeNull();
    });

    it('derives partial review reasons with stable runtime class tagging (table-driven)', () => {
      const cases = [
        {
          label: 'deadline reason tags once',
          partialReason: 'Review deadline exceeded (300s)',
          expectedTag: '[class=deadline]',
        },
        {
          label: 'network reason tags once',
          partialReason: 'socket hang up while reading response stream',
          expectedTag: '[class=network]',
        },
        {
          label: 'pre-tagged reasons are not double-tagged',
          partialReason: 'Review timeout [class=timeout]',
          expectedTag: '[class=timeout]',
          expectedOccurrences: 1,
        },
      ];

      for (const testCase of cases) {
        const persisted = reviewService.__testing.derivePersistedReviewErrorFromResult({
          summary: 'Partial output available.',
          riskLevel: 'medium',
          changeGroups: [],
          recommendations: [],
          stats: {
            reviewTier: 'partial',
            isPartial: true,
            partialChunksCompleted: 1,
            partialChunksTotal: 2,
            partialReason: testCase.partialReason,
          },
        });

        expect(persisted, testCase.label).toContain(testCase.expectedTag);
        const matches = persisted.match(/\[class=[^\]]+\]/g) || [];
        expect(matches.length, testCase.label).toBe(testCase.expectedOccurrences || 1);
      }
    });

    it('classifies documentation changes as trivial for per-file strategy', () => {
      const fileClass = reviewService.__testing.classifyFileForPerFileReview({
        path: 'docs/architecture.md',
        status: 'M',
        before: 'line a\nline b',
        after: 'line a\nline b\nline c',
      });
      expect(fileClass).toBe('trivial');
    });

    it('builds stable per-file cache keys for identical inputs', () => {
      const descriptorA = reviewService.__testing.buildReviewFileCacheDescriptor({
        contextType: 'changeset',
        file: {
          path: 'src/service.ts',
          before: 'export const a = 1;\n',
          after: 'export const a = 2;\n',
        },
        providerType: 'openai',
        providerModel: 'gpt-5.3-codex',
        qualityMode: 'v2',
      });
      const descriptorB = reviewService.__testing.buildReviewFileCacheDescriptor({
        contextType: 'changeset',
        file: {
          path: 'src/service.ts',
          before: 'export const a = 1;\n',
          after: 'export const a = 2;\n',
        },
        providerType: 'openai',
        providerModel: 'gpt-5.3-codex',
        qualityMode: 'v2',
      });

      expect(descriptorA.cacheKey).toBe(descriptorB.cacheKey);
      expect(descriptorA.beforeHash).toBe(descriptorB.beforeHash);
      expect(descriptorA.afterHash).toBe(descriptorB.afterHash);
    });

    it('invalidates per-file cache key when provider model changes', () => {
      const descriptorA = reviewService.__testing.buildReviewFileCacheDescriptor({
        contextType: 'branch_review',
        file: {
          path: 'backend/src/server.js',
          before: 'const x = 1;',
          after: 'const x = 2;',
        },
        providerType: 'anthropic',
        providerModel: 'claude-opus-4-6',
        qualityMode: 'v2',
      });
      const descriptorB = reviewService.__testing.buildReviewFileCacheDescriptor({
        contextType: 'branch_review',
        file: {
          path: 'backend/src/server.js',
          before: 'const x = 1;',
          after: 'const x = 2;',
        },
        providerType: 'anthropic',
        providerModel: 'claude-sonnet-4-5',
        qualityMode: 'v2',
      });

      expect(descriptorA.cacheKey).not.toBe(descriptorB.cacheKey);
    });

    it('invalidates per-file cache key when strategy resolves to a different effective model', () => {
      const providerData = {
        provider: {
          type: 'anthropic',
          model: 'claude-opus-4-6',
        },
      };
      const smartModel = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        { strategy: 'smart' }
      ).model;
      const latencyModel = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        { strategy: 'latency_first' }
      ).model;

      expect(smartModel).toBe('claude-opus-4-6');
      expect(latencyModel).toBe('claude-sonnet-4-6');

      const base = {
        contextType: 'branch_review',
        file: {
          path: 'backend/src/server.js',
          before: 'const mode = "old";',
          after: 'const mode = "new";',
        },
        providerType: 'anthropic',
        qualityMode: 'v2',
      };

      const smartDescriptor = reviewService.__testing.buildReviewFileCacheDescriptor({
        ...base,
        providerModel: smartModel,
        effectiveStrategy: 'smart',
      });
      const latencyDescriptor = reviewService.__testing.buildReviewFileCacheDescriptor({
        ...base,
        providerModel: latencyModel,
        effectiveStrategy: 'latency_first',
      });

      expect(smartDescriptor.cacheKey).not.toBe(latencyDescriptor.cacheKey);
    });

    it('invalidates per-file cache keys when cost-aware routing selects a different model', () => {
      const providerData = {
        provider: {
          type: 'openai',
          model: 'gpt-5.3-codex',
        },
      };
      const adaptiveConfig = {
        strategy: 'adaptive',
        adaptive: {
          fastPathMaxFiles: 10,
          fastPathMaxDiffChars: 10000,
          preferQualityOnHighRisk: true,
        },
      };
      const fastPathModel = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        adaptiveConfig,
        { fileCount: 2, diffChars: 3000, highRiskHints: false }
      ).model;
      const qualityPathModel = reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        adaptiveConfig,
        { fileCount: 24, diffChars: 120000, highRiskHints: true }
      ).model;

      expect(fastPathModel).toBe('gpt-5.3-codex');
      expect(qualityPathModel).toBe('gpt-5.5');

      const base = {
        contextType: 'changeset',
        file: {
          path: 'src/adaptive.ts',
          before: 'export const level = 1;',
          after: 'export const level = 2;',
        },
        providerType: 'openai',
        qualityMode: 'v2',
      };

      const fastDescriptor = reviewService.__testing.buildReviewFileCacheDescriptor({
        ...base,
        providerModel: fastPathModel,
        effectiveStrategy: 'adaptive',
      });
      const qualityDescriptor = reviewService.__testing.buildReviewFileCacheDescriptor({
        ...base,
        providerModel: qualityPathModel,
        effectiveStrategy: 'adaptive',
      });

      expect(fastDescriptor.cacheKey).not.toBe(qualityDescriptor.cacheKey);
    });

    it('invalidates per-file cache key when prompt version changes', () => {
      const baseArgs = {
        contextType: 'changeset',
        file: {
          path: 'src/worker.ts',
          before: 'export const version = 1;',
          after: 'export const version = 2;',
        },
        providerType: 'openai',
        providerModel: 'gpt-5.3-codex',
        qualityMode: 'v2',
      };
      const descriptorA = reviewService.__testing.buildReviewFileCacheDescriptor({
        ...baseArgs,
        promptVersion: 'prompt-v1',
      });
      const descriptorB = reviewService.__testing.buildReviewFileCacheDescriptor({
        ...baseArgs,
        promptVersion: 'prompt-v2',
      });

      expect(descriptorA.cacheKey).not.toBe(descriptorB.cacheKey);
    });

    it('invalidates per-file cache key when file content changes', () => {
      const descriptorA = reviewService.__testing.buildReviewFileCacheDescriptor({
        contextType: 'changeset',
        file: {
          path: 'src/worker.ts',
          before: 'export const v = 1;',
          after: 'export const v = 2;',
        },
        providerType: 'openai',
        providerModel: 'gpt-5.3-codex',
        qualityMode: 'v2',
      });
      const descriptorB = reviewService.__testing.buildReviewFileCacheDescriptor({
        contextType: 'changeset',
        file: {
          path: 'src/worker.ts',
          before: 'export const v = 1;',
          after: 'export const v = 3;',
        },
        providerType: 'openai',
        providerModel: 'gpt-5.3-codex',
        qualityMode: 'v2',
      });

      expect(descriptorA.cacheKey).not.toBe(descriptorB.cacheKey);
      expect(descriptorA.afterHash).not.toBe(descriptorB.afterHash);
    });

    it('partitions per-file cache keys by review context type', () => {
      const shared = {
        file: {
          path: 'src/cache.ts',
          before: 'export const cache = false;',
          after: 'export const cache = true;',
        },
        providerType: 'openai',
        providerModel: 'gpt-5.3-codex',
        qualityMode: 'v2',
      };
      const changesetDescriptor = reviewService.__testing.buildReviewFileCacheDescriptor({
        ...shared,
        contextType: 'changeset',
      });
      const branchDescriptor = reviewService.__testing.buildReviewFileCacheDescriptor({
        ...shared,
        contextType: 'branch_review',
      });

      expect(changesetDescriptor.cacheKey).not.toBe(branchDescriptor.cacheKey);
    });

    it('assigns partial tier when review is marked partial', () => {
      const review = {
        summary: 'Partial',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [],
        stats: { isPartial: true },
      };
      reviewService.__testing.assignReviewTier(review);
      expect(review.stats.reviewTier).toBe('partial');
    });

    it('assigns files_only tier when findings exist without synthesized groups', () => {
      const review = {
        summary: 'Files analyzed',
        riskLevel: 'low',
        changeGroups: [],
        recommendations: [{ type: 'issue', severity: 'low', title: 'X', description: 'Y' }],
        stats: {},
      };
      reviewService.__testing.assignReviewTier(review);
      expect(review.stats.reviewTier).toBe('files_only');
    });

    it('revalidates high/critical findings with verifier budgets and records skipped_budget deterministically', async () => {
      const review = {
        summary: 'Verifier budget check',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          { type: 'issue', severity: 'critical', title: 'Critical guard missing', description: 'Guard is absent.', file: 'src/a.ts', line: 10 },
          { type: 'issue', severity: 'high', title: 'High fallback missing', description: 'Fallback is absent.', file: 'src/b.ts', line: 20 },
          { type: 'issue', severity: 'medium', title: 'Medium issue', description: 'Medium.', file: 'src/c.ts', line: 30 },
        ],
        stats: {},
      };

      const verifiedTitles = [];
      const result = await reviewService.__testing.runBoundedHighRiskVerifierPass(review, {
        enabled: true,
        maxFindings: 1,
        unsupportedPolicy: 'demote',
        verifyRecommendation: async (rec) => {
          verifiedTitles.push(rec.title);
          return { decision: 'supported' };
        },
      });

      expect(verifiedTitles).toEqual(['Critical guard missing']);
      expect(result.stats.verifierSupported).toBe(1);
      expect(result.stats.verifierSkippedBudget).toBe(1);
    });

    it('applies deterministic unsupported policy mapping for verifier outcomes', async () => {
      const review = {
        summary: 'Verifier policy check',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          { type: 'issue', severity: 'critical', title: 'Critical auth gap', description: 'Auth bypass path.', file: 'src/auth.ts', line: 42 },
          { type: 'issue', severity: 'high', title: 'High timeout gap', description: 'Timeout path missing.', file: 'src/api.ts', line: 21 },
        ],
        stats: {},
      };

      const demoted = await reviewService.__testing.runBoundedHighRiskVerifierPass(review, {
        enabled: true,
        maxFindings: 2,
        unsupportedPolicy: 'demote',
        verifyRecommendation: async (rec) => (
          rec.title.includes('auth')
            ? { decision: 'unsupported' }
            : { decision: 'needs_more_context' }
        ),
      });
      const demotedRec = demoted.recommendations.find((rec) => rec.title === 'Critical auth gap');
      expect(demotedRec?.type).toBe('suggestion');
      expect(demotedRec?.severity).toBe('medium');
      expect(demoted.stats.verifierUnsupported).toBe(1);
      expect(demoted.stats.verifierNeedsMoreContext).toBe(1);

      const hidden = await reviewService.__testing.runBoundedHighRiskVerifierPass(review, {
        enabled: true,
        maxFindings: 2,
        unsupportedPolicy: 'hide',
        verifyRecommendation: async () => ({ decision: 'unsupported' }),
      });
      expect(hidden.recommendations).toHaveLength(0);
      expect(hidden.stats.verifierUnsupported).toBe(2);
    });

    it('expands verifier coverage to medium findings when medium gate passes', async () => {
      const review = {
        summary: 'Verifier medium expansion',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          { type: 'issue', severity: 'high', title: 'High issue', description: 'High.', file: 'src/a.ts', line: 10 },
          { type: 'issue', severity: 'medium', title: 'Medium issue', description: 'Medium.', file: 'src/b.ts', line: 20 },
        ],
        stats: {
          totalChangedFiles: 12,
          deepReviewedFiles: 12,
          omittedFiles: 0,
          firstSignalMs: 22000,
          totalDurationMs: 70000,
        },
      };

      const verifiedTiers = [];
      const result = await reviewService.__testing.runBoundedHighRiskVerifierPass(review, {
        enabled: true,
        maxFindings: 1,
        includeMedium: true,
        maxMediumFindings: 1,
        mediumGate: {
          maxFirstSignalMs: 90000,
          maxDurationMs: 180000,
          maxOmittedRate: 0.4,
          minDeepReviewedFiles: 6,
        },
        unsupportedPolicy: 'demote',
        verifyRecommendation: async (_rec, meta = {}) => {
          verifiedTiers.push(meta.tier);
          return { decision: 'supported' };
        },
      });

      expect(verifiedTiers).toEqual(['high_risk', 'medium']);
      expect(result.stats.verifierChecked).toBe(2);
      expect(result.stats.verifierMediumGateStatus).toBe('pass');
      expect(result.stats.verifierMediumChecked).toBe(1);
      expect(result.stats.verifierMediumConsidered).toBe(1);
    });

    it('auto-falls back to high/critical verification when medium gate blocks expansion', async () => {
      const review = {
        summary: 'Verifier medium fallback',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          { type: 'issue', severity: 'high', title: 'High issue', description: 'High.', file: 'src/a.ts', line: 10 },
          { type: 'issue', severity: 'medium', title: 'Medium issue', description: 'Medium.', file: 'src/b.ts', line: 20 },
        ],
        stats: {
          totalChangedFiles: 12,
          deepReviewedFiles: 12,
          omittedFiles: 0,
          firstSignalMs: 180000,
          totalDurationMs: 70000,
        },
      };

      const verifiedTiers = [];
      const result = await reviewService.__testing.runBoundedHighRiskVerifierPass(review, {
        enabled: true,
        maxFindings: 1,
        includeMedium: true,
        maxMediumFindings: 1,
        mediumGate: {
          maxFirstSignalMs: 90000,
          maxDurationMs: 180000,
          maxOmittedRate: 0.4,
          minDeepReviewedFiles: 6,
        },
        unsupportedPolicy: 'demote',
        verifyRecommendation: async (_rec, meta = {}) => {
          verifiedTiers.push(meta.tier);
          return { decision: 'supported' };
        },
      });

      expect(verifiedTiers).toEqual(['high_risk']);
      expect(result.stats.verifierChecked).toBe(1);
      expect(result.stats.verifierMediumGateStatus).toBe('blocked');
      expect(result.stats.verifierMediumChecked).toBe(0);
      expect(result.stats.verifierMediumConsidered).toBe(1);
      expect(result.stats.verifierMediumGateReasonCodes).toContain('medium_gate_first_signal_slow');
    });

    it('does not block medium expansion when first-signal telemetry is missing', async () => {
      const review = {
        summary: 'Verifier medium telemetry fallback',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          { type: 'issue', severity: 'high', title: 'High issue', description: 'High.', file: 'src/a.ts', line: 10 },
          { type: 'issue', severity: 'medium', title: 'Medium issue', description: 'Medium.', file: 'src/b.ts', line: 20 },
        ],
        stats: {
          totalChangedFiles: 2,
          deepReviewedFiles: 2,
          omittedFiles: 0,
          totalDurationMs: 18000,
        },
      };

      const verifiedTiers = [];
      const result = await reviewService.__testing.runBoundedHighRiskVerifierPass(review, {
        enabled: true,
        maxFindings: 1,
        includeMedium: true,
        maxMediumFindings: 1,
        mediumGate: {
          maxFirstSignalMs: 90000,
          maxDurationMs: 180000,
          maxOmittedRate: 0.4,
          minDeepReviewedFiles: 1,
        },
        unsupportedPolicy: 'demote',
        verifyRecommendation: async (_rec, meta = {}) => {
          verifiedTiers.push(meta.tier);
          return { decision: 'supported' };
        },
      });

      expect(verifiedTiers).toEqual(['high_risk', 'medium']);
      expect(result.stats.verifierMediumGateStatus).toBe('pass');
      expect(result.stats.verifierMediumGateReasonCodes).toEqual([]);
    });

    it('applies corroboration policy deterministically and downgrades unsupported high-risk findings', () => {
      const review = {
        summary: 'Corroboration policy check',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          {
            type: 'issue',
            severity: 'critical',
            title: 'Auth bypass risk',
            description: 'Auth guard removed.',
            file: 'src/auth.ts',
            line: 17,
            verifierDecision: 'unsupported',
          },
          {
            type: 'issue',
            severity: 'high',
            title: 'Grounded timeout gap',
            description: 'Timeout fallback missing.',
            file: 'src/api.ts',
            line: 22,
            evidenceSnippet: 'if (!timeout) return;',
          },
        ],
        stats: {},
      };

      const result = reviewService.__testing.applyCorroborationPolicyToReview(review, {
        enabled: true,
        allowGroundedFallback: true,
        downgradeOnUnsupported: true,
      });
      reviewService.__testing.normalizePrecisionIssueCounters(result);

      const unsupported = result.recommendations.find((rec) => rec.title === 'Auth bypass risk');
      const supported = result.recommendations.find((rec) => rec.title === 'Grounded timeout gap');

      expect(unsupported?.severity).toBe('high');
      expect(unsupported?.confidence).toBe('low');
      expect(unsupported?.corroboration?.status).toBe('unsupported');
      expect(unsupported?.corroboration?.downgradedFrom).toBe('critical');
      expect(unsupported?.corroboration?.downgradedTo).toBe('high');
      expect(supported?.corroboration?.status).toBe('supported');
      expect(result.stats.corroborationChecked).toBe(2);
      expect(result.stats.corroborationDowngraded).toBe(1);
      expect(result.stats.corroborationSourceClassCounts).toEqual({
        grounding: 1,
        verifier: 1,
      });
    });

    it('uses verification-log corroboration source evaluator when matching failing check logs', () => {
      const evaluator = reviewService.__testing.createVerificationLogCorroborationSourceEvaluator({
        lint: 'fail',
        unit: 'pass',
        e2e: 'not_run',
        logs: {
          lint: 'security warning: missing auth guard in src/auth.ts',
        },
      });

      const result = reviewService.__testing.applyCorroborationPolicyToReview({
        summary: 'Corroboration source evaluator',
        riskLevel: 'high',
        changeGroups: [],
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Missing auth guard',
            description: 'Auth guard removed in route handler.',
            file: 'src/auth.ts',
            line: 21,
          },
        ],
        stats: {},
      }, {
        enabled: true,
        allowGroundedFallback: true,
        downgradeOnUnsupported: true,
        sourceEvaluator: evaluator,
      });
      reviewService.__testing.normalizePrecisionIssueCounters(result);

      const rec = result.recommendations[0];
      expect(rec.corroboration?.sourceClass).toBe('deterministic_tool');
      expect(rec.corroboration?.sourceName).toBe('verification:lint');
      expect(result.stats.corroborationSourceClassCounts).toEqual({
        deterministic_tool: 1,
      });
      expect(result.stats.corroborationSourceNameCounts).toEqual({
        'verification:lint': 1,
      });
    });

    it('suppresses recurring dismissed low-risk recommendations with threshold gates and exemptions', async () => {
      const review = {
        summary: 'Suppression policy check',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [
          {
            type: 'suggestion',
            severity: 'low',
            title: 'Rename helper',
            description: 'Improve naming.',
            file: 'src/name.ts',
            line: 6,
          },
          {
            type: 'issue',
            severity: 'critical',
            title: 'Critical auth bypass',
            description: 'Security-sensitive gap.',
            file: 'src/auth.ts',
            line: 20,
          },
        ],
        stats: {},
      };

      const recommendationKey = reviewOutcomeService.getRecommendationIdentityKey(review.recommendations[0]);
      const lookupSpy = vi.spyOn(reviewOutcomeService, 'listProjectOutcomesByRecommendationKeys')
        .mockResolvedValue({
          projectId: 'project-1',
          outcomes: [],
          byRecommendationKey: {
            [recommendationKey]: {
              recommendationKey,
              total: 5,
              dismissed: 5,
              addressed: 0,
              dismissedRate: 1,
            },
          },
        });

      const result = await reviewService.__testing.applyOutcomeSuppressionPolicyToReview(review, {
        projectId: 'project-1',
        enabled: true,
        minSamples: 3,
        minDismissedRate: 0.8,
        maxPerRun: 2,
      });
      lookupSpy.mockRestore();

      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].title).toBe('Critical auth bypass');
      expect(result.stats.outcomeSuppressionSuppressed).toBe(1);
      expect(result.stats.outcomeSuppressionChecked).toBe(1);
      expect(result.stats.reviewOutcomeTelemetry).toEqual({
        issueTotal: 5,
        issueDismissed: 5,
        issueAddressed: 0,
      });
    });

    it('queries outcome suppression history with provider/model/language/path buckets', async () => {
      const recommendation = {
        type: 'suggestion',
        severity: 'low',
        title: 'Rename helper',
        description: 'Improve naming.',
        file: 'src/name.ts',
        line: 6,
      };
      const review = {
        summary: 'Suppression dimensions',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [recommendation],
        stats: {},
      };

      const recommendationKey = reviewOutcomeService.getRecommendationIdentityKey(recommendation);
      const lookupSpy = vi.spyOn(reviewOutcomeService, 'listProjectOutcomesByRecommendationKeys')
        .mockResolvedValue({
          projectId: 'project-1',
          outcomes: [],
          byRecommendationKey: {
            [recommendationKey]: {
              recommendationKey,
              total: 2,
              dismissed: 2,
              addressed: 0,
              dismissedRate: 1,
            },
          },
        });

      await reviewService.__testing.applyOutcomeSuppressionPolicyToReview(review, {
        projectId: 'project-1',
        providerType: 'openai',
        providerModel: 'gpt-5.3-codex',
        enabled: true,
        minSamples: 2,
        minDismissedRate: 0.8,
        maxPerRun: 1,
      });

      expect(lookupSpy).toHaveBeenCalledTimes(1);
      const options = lookupSpy.mock.calls[0][2];
      expect(options.dimensionsByRecommendationKey[recommendationKey]).toEqual({
        providerType: 'openai',
        providerModel: 'gpt-5.3-codex',
        language: 'typescript',
        pathPattern: 'src/**',
      });
      lookupSpy.mockRestore();
    });
  });

  describe('Changeset review status lifecycle', () => {
    it('changeset starts with reviewStatus not set', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Test lifecycle',
        source: 'manual',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      expect(changeset.reviewStatus).toBeUndefined();
    });

    it('updateChangeSetReview updates both full file and index', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Test update',
        source: 'manual',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      await reviewService.updateChangeSetReview(testProjectPath, changeset.id, {
        reviewStatus: 'reviewed',
        reviewRiskLevel: 'medium',
        reviewSummary: 'Test summary',
        reviewedBy: 'anthropic/claude-sonnet-4-6',
        reviewedAt: '2026-02-11T00:00:00.000Z',
      });

      // Check full changeset
      const updated = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(updated.reviewStatus).toBe('reviewed');
      expect(updated.reviewRiskLevel).toBe('medium');
      expect(updated.reviewSummary).toBe('Test summary');

      // Check index
      const allCs = await changesetService.getChangeSets(testProjectPath);
      const indexed = allCs.find(cs => cs.id === changeset.id);
      expect(indexed.reviewStatus).toBe('reviewed');
      expect(indexed.reviewRiskLevel).toBe('medium');
    });

    it('updateChangeSetReview handles reviewing → failed lifecycle', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Test failure',
        source: 'manual',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      // Simulate reviewing
      await reviewService.updateChangeSetReview(testProjectPath, changeset.id, {
        reviewStatus: 'reviewing',
      });

      let updated = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(updated.reviewStatus).toBe('reviewing');

      // Simulate failure
      await reviewService.updateChangeSetReview(testProjectPath, changeset.id, {
        reviewStatus: 'failed',
        reviewError: 'API timeout',
      });

      updated = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(updated.reviewStatus).toBe('failed');
      expect(updated.reviewError).toBe('API timeout');
    });

    it('reconciles interrupted queued/reviewing changeset records to failed terminal metadata', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Interrupted review',
        source: 'manual',
        files: [{ path: 'recovery.js', before: null, after: 'console.log(\"recover\");' }],
      });

      await reviewService.updateChangeSetReview(testProjectPath, changeset.id, {
        reviewStatus: 'reviewing',
        reviewSummary: null,
        reviewError: null,
      });

      const recoveredCount = await changesetService.markInterruptedReviewsAsFailed(testProjectPath);
      expect(recoveredCount).toBe(1);

      const updated = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(updated.reviewStatus).toBe('failed');
      expect(updated.reviewError).toContain('Review interrupted after app restart');
      expect(typeof updated.reviewedAt).toBe('string');

      const allCs = await changesetService.getChangeSets(testProjectPath);
      const indexed = allCs.find((entry) => entry.id === changeset.id);
      expect(indexed.reviewStatus).toBe('failed');
      expect(indexed.reviewError).toContain('Review interrupted after app restart');
      expect(typeof indexed.reviewedAt).toBe('string');
    });
  });

  describe('Verification → Review interaction', () => {
    it('changeset verification fields are independent of review fields', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Independence test',
        source: 'manual',
        files: [{ path: 'test.js', before: null, after: 'const x = 1;' }],
      });

      // Update verification
      await changesetService.updateChangeSetVerification(
        testProjectPath, changeset.id, 'lint', 'pass', 'All good'
      );

      // Update review status
      await reviewService.updateChangeSetReview(testProjectPath, changeset.id, {
        reviewStatus: 'reviewed',
        reviewRiskLevel: 'low',
      });

      // Both should coexist
      const updated = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(updated.verification.lint).toBe('pass');
      expect(updated.reviewStatus).toBe('reviewed');
      expect(updated.reviewRiskLevel).toBe('low');
    });
  });

  describe('Recommendation outcome sync contracts', () => {
    it('keeps recommendation identity keys deterministic across equivalent payload shapes', () => {
      const fromUi = {
        type: 'issue',
        severity: 'high',
        title: 'Missing auth guard',
        description: 'Route can be called without authorization.',
        file: 'src/routes/admin.ts',
        line: 42,
        suggestedFix: 'Add requireAdmin middleware.',
      };
      const fromBackend = {
        type: ' issue ',
        severity: 'HIGH',
        title: 'Missing auth guard',
        description: 'Route can be called without authorization.',
        file: 'src/routes/admin.ts',
        line: '42',
        suggestedFix: 'Add requireAdmin middleware.',
      };

      const uiKey = reviewOutcomeService.__testing.getRecommendationIdentityKey(fromUi);
      const backendKey = reviewOutcomeService.__testing.getRecommendationIdentityKey(fromBackend);

      expect(uiKey).toBe(backendKey);
    });

    it('reconciles conflicting persisted outcomes to the latest server state', () => {
      const recommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey({
        type: 'issue',
        severity: 'medium',
        title: 'Missing timeout',
        description: 'External call has no timeout.',
        file: 'src/http/client.ts',
        line: 17,
        suggestedFix: 'Set a bounded timeout and fallback behavior.',
      });
      const deduped = reviewOutcomeService.__testing.dedupeToLatestOutcomeRecords([
        {
          project_id: 'project-1',
          review_type: 'changeset',
          review_id: 'cs-1',
          recommendation_key: recommendationKey,
          status: 'addressed',
          note: 'fixed',
          created_at: '2026-02-22T10:00:00.000Z',
          updated_at: '2026-02-22T10:01:00.000Z',
        },
        {
          project_id: 'project-1',
          review_type: 'changeset',
          review_id: 'cs-1',
          recommendation_key: recommendationKey,
          status: 'dismissed',
          note: 'intentional for this endpoint',
          created_at: '2026-02-22T10:00:00.000Z',
          updated_at: '2026-02-22T10:03:00.000Z',
        },
      ]);

      expect(deduped).toHaveLength(1);
      expect(deduped[0].status).toBe('dismissed');
      expect(deduped[0].note).toBe('intentional for this endpoint');
      expect(deduped[0].updatedAt).toBe('2026-02-22T10:03:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  // Agentic quality guard integration tests
  // -------------------------------------------------------------------------

  describe('Agentic mode quality guards', () => {
    const DIFF_FILE_PATHS = [
      'backend/src/services/review/reviewProviderExecution.js',
      'backend/src/services/review/reviewPromptBuilder.js',
      'backend/src/services/review/reviewConstants.js',
      'frontend/src/components/ReviewPanel.tsx',
      'frontend/src/types/index.ts',
    ];

    const AGENTIC_CONTEXT = {
      filePaths: DIFF_FILE_PATHS,
      fileCount: 5,
      totalAdditions: 300,
      totalDeletions: 50,
      qualityMode: 'v2',
      agenticMode: true,
    };

    function buildAgenticReviewJson(overrides = {}) {
      return JSON.stringify({
        summary: 'Review of changes on the branch.',
        riskLevel: 'medium',
        changeGroups: [
          {
            label: 'Review execution improvements',
            description: 'Changes to how reviews are executed.',
            risk: 'medium',
            files: [
              { path: 'backend/src/services/review/reviewProviderExecution.js', additions: 150, deletions: 20, description: 'Agentic review changes.' },
              { path: 'backend/src/services/review/reviewConstants.js', additions: 30, deletions: 5, description: 'New constants.' },
            ],
          },
          {
            label: 'Quality guard updates',
            description: 'Quality guard normalization.',
            risk: 'low',
            files: [
              { path: 'backend/src/services/review/reviewPromptBuilder.js', additions: 80, deletions: 15, description: 'Guard logic.' },
            ],
          },
          {
            label: 'Frontend updates',
            description: 'UI changes.',
            risk: 'low',
            files: [
              { path: 'frontend/src/components/ReviewPanel.tsx', additions: 30, deletions: 5, description: 'Display updates.' },
              { path: 'frontend/src/types/index.ts', additions: 10, deletions: 5, description: 'Type changes.' },
            ],
          },
        ],
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Missing error handling in timeout path',
            description: 'The timeout handler does not clean up resources.',
            file: 'backend/src/services/review/reviewProviderExecution.js',
            line: 150,
            evidence: { file: 'backend/src/services/review/reviewProviderExecution.js', line: 150, snippet: 'timer = setTimeout(() => {', reasoning: 'Timer fires but never calls cleanup.' },
          },
          {
            type: 'suggestion',
            severity: 'medium',
            title: 'Consider extracting helper function',
            description: 'The path normalization is repeated in 3 places.',
            file: 'backend/src/services/review/reviewPromptBuilder.js',
            line: 55,
            evidence: { file: 'backend/src/services/review/reviewPromptBuilder.js', line: 55, snippet: 'normalizePathForMatch()', reasoning: 'DRY principle.' },
          },
          {
            type: 'praise',
            severity: 'low',
            title: 'Good test coverage',
            description: 'Comprehensive test additions for the new tier logic.',
          },
        ],
        stats: { filesAnalyzed: 5, totalAdditions: 300, totalDeletions: 50, estimatedComplexity: 'moderate' },
        ...overrides,
      });
    }

    it('preserves recommendations with exact diff paths and drops changeGroups (Phase 11)', () => {
      const result = reviewService.parseReviewResponse(
        buildAgenticReviewJson(),
        AGENTIC_CONTEXT,
      );
      // Phase 11: walkthrough is decoupled. Fresh review output must drop
      // changeGroups; recommendations remain intact with grounded paths.
      expect(result.changeGroups).toBeNull();
      expect(result.recommendations.length).toBeGreaterThanOrEqual(2);
      expect(result.recommendations.some(r => r.type === 'issue')).toBe(true);
      expect(result.recommendations.some(r => r.type === 'praise')).toBe(true);
    });

    it('resolves subdirectory-relative paths via suffix matching', () => {
      // Simulate CLI returning paths without the leading `backend/` prefix
      const result = reviewService.parseReviewResponse(
        buildAgenticReviewJson({
          changeGroups: [
            {
              label: 'Execution changes',
              description: 'Changes to execution.',
              risk: 'medium',
              files: [
                { path: 'src/services/review/reviewProviderExecution.js', additions: 100, deletions: 10, description: 'Changes.' },
                { path: 'src/services/review/reviewConstants.js', additions: 20, deletions: 3, description: 'Constants.' },
              ],
            },
          ],
          recommendations: [
            {
              type: 'issue',
              severity: 'high',
              title: 'Bug in path resolution',
              description: 'Suffix match can fail.',
              file: 'src/services/review/reviewProviderExecution.js',
              line: 100,
              evidence: { file: 'src/services/review/reviewProviderExecution.js', line: 100, snippet: 'const path = ...', reasoning: 'Path mismatch.' },
            },
          ],
        }),
        AGENTIC_CONTEXT,
      );
      // Phase 11: changeGroups is no longer part of fresh review output.
      // Recommendation paths still get suffix-resolved.
      expect(result.changeGroups).toBeNull();
      expect(result.recommendations.some(r => r.file === 'backend/src/services/review/reviewProviderExecution.js')).toBe(true);
    });

    it('filters recommendations without any evidence in agentic mode', () => {
      const result = reviewService.parseReviewResponse(
        buildAgenticReviewJson({
          recommendations: [
            {
              type: 'issue',
              severity: 'medium',
              title: 'No evidence at all',
              description: 'A vague finding with no file, line, or evidence.',
              // No file, no line, no evidence object
            },
            {
              type: 'issue',
              severity: 'high',
              title: 'Has evidence',
              description: 'A grounded finding.',
              file: 'backend/src/services/review/reviewProviderExecution.js',
              line: 50,
              evidence: { file: 'backend/src/services/review/reviewProviderExecution.js', line: 50, snippet: 'code()', reasoning: 'Reason.' },
            },
            {
              type: 'praise',
              severity: 'low',
              title: 'Praise passes without evidence',
              description: 'Good work!',
            },
          ],
        }),
        AGENTIC_CONTEXT,
      );
      // The no-evidence issue should be filtered; the grounded issue and praise should remain
      const issues = result.recommendations.filter(r => r.type === 'issue');
      const praises = result.recommendations.filter(r => r.type === 'praise');
      expect(issues.length).toBe(1);
      expect(issues[0].title).toBe('Has evidence');
      expect(praises.length).toBe(1);
    });

    it('allows no-evidence agentic recommendations when policy disables evidence requirement', () => {
      const result = reviewService.parseReviewResponse(
        buildAgenticReviewJson({
          recommendations: [
            {
              type: 'issue',
              severity: 'medium',
              title: 'No evidence at all',
              description: 'A vague finding with no file, line, or evidence.',
            },
          ],
        }),
        {
          ...AGENTIC_CONTEXT,
          reviewPolicy: {
            defaults: {
              requireEvidence: false,
            },
          },
        },
      );

      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].title).toBe('No evidence at all');
    });

    it('does not let the agentic budget multiplier exceed a policy recommendation cap', () => {
      const result = reviewService.parseReviewResponse(
        buildAgenticReviewJson({
          recommendations: [
            {
              type: 'issue',
              severity: 'high',
              title: 'First grounded issue',
              description: 'Grounded and should remain.',
              file: 'backend/src/services/review/reviewProviderExecution.js',
              line: 50,
              evidence: { file: 'backend/src/services/review/reviewProviderExecution.js', line: 50, snippet: 'code()', reasoning: 'Reason.' },
            },
            {
              type: 'issue',
              severity: 'medium',
              title: 'Second grounded issue',
              description: 'Grounded but should be capped out.',
              file: 'backend/src/services/review/reviewProviderExecution.js',
              line: 60,
              evidence: { file: 'backend/src/services/review/reviewProviderExecution.js', line: 60, snippet: 'code2()', reasoning: 'Reason 2.' },
            },
          ],
        }),
        {
          ...AGENTIC_CONTEXT,
          reviewPolicy: {
            defaults: {
              maxRecommendations: 1,
            },
          },
        },
      );

      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].title).toBe('First grounded issue');
    });

    it('does not produce empty results from a well-formed agentic response', () => {
      const result = reviewService.parseReviewResponse(
        buildAgenticReviewJson(),
        AGENTIC_CONTEXT,
      );
      // Phase 11: regression guard now focuses on recommendations only —
      // changeGroups is intentionally dropped from fresh review output.
      expect(result.changeGroups).toBeNull();
      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    it('handles completely unresolvable paths gracefully', () => {
      const result = reviewService.parseReviewResponse(
        buildAgenticReviewJson({
          changeGroups: [
            {
              label: 'Unknown paths',
              description: 'Files not in the diff.',
              risk: 'low',
              files: [
                { path: 'totally/unknown/file.js', additions: 10, deletions: 0, description: 'Unknown.' },
              ],
            },
          ],
          recommendations: [
            {
              type: 'issue',
              severity: 'medium',
              title: 'Finding on unknown path',
              description: 'Path not in diff.',
              file: 'totally/unknown/file.js',
              line: 10,
              evidence: { file: 'totally/unknown/file.js', line: 10, snippet: '...', reasoning: 'Unknown.' },
            },
          ],
        }),
        AGENTIC_CONTEXT,
      );
      // In agentic mode, unresolvable recommendation paths are now nulled
      // (both file and line) to avoid broken links in the UI.
      // The issue still exists but with no file/line grounding — it will be
      // caught by the evidence filter since rec.file is now null.
      expect(result).toBeDefined();
      // The evidence filter drops issues without any evidence (file is null,
      // line is null, but evidence.reasoning still exists so the rec survives
      // evidence filtering — however file+line are cleared).
      const issues = result.recommendations.filter(r => r.type === 'issue');
      for (const issue of issues) {
        // File is nulled since it couldn't be resolved to an allowed path
        expect(issue.file).toBeNull();
        expect(issue.line).toBeNull();
      }
    });

    it('non-agentic mode applies stricter path filtering', () => {
      const nonAgenticContext = { ...AGENTIC_CONTEXT, agenticMode: false };
      const result = reviewService.parseReviewResponse(
        buildAgenticReviewJson({
          changeGroups: [
            {
              label: 'Subdirectory paths',
              description: 'Relative paths.',
              risk: 'medium',
              files: [
                { path: 'src/services/review/reviewProviderExecution.js', additions: 50, deletions: 5, description: 'Changes.' },
              ],
            },
          ],
        }),
        nonAgenticContext,
      );
      // Phase 11: changeGroups is no longer part of fresh review output —
      // even valid groups get dropped on the floor since walkthrough is now
      // its own artifact.
      expect(result.changeGroups).toBeNull();
    });
  });

  describe('Empty agentic response rejection', () => {
    const agenticCtx = {
      filePaths: ['backend/src/services/review/reviewProviderExecution.js'],
      fileCount: 1,
      totalAdditions: 100,
      totalDeletions: 10,
      qualityMode: 'v2',
      agenticMode: true,
    };

    it('rejects empty JSON object in agentic mode', () => {
      expect(() =>
        reviewService.parseReviewResponse('{}', agenticCtx)
      ).toThrow(/empty or minimal JSON/);
    });

    it('rejects JSON with only riskLevel in agentic mode', () => {
      expect(() =>
        reviewService.parseReviewResponse(JSON.stringify({ riskLevel: 'low' }), agenticCtx)
      ).toThrow(/empty or minimal JSON/);
    });

    it('accepts JSON with only riskLevel in non-agentic mode', () => {
      const result = reviewService.parseReviewResponse(JSON.stringify({ riskLevel: 'low' }));
      expect(result).toBeDefined();
      expect(result.riskLevel).toBe('low');
    });

    it('accepts agentic response with summary', () => {
      const result = reviewService.parseReviewResponse(
        JSON.stringify({
          summary: 'This PR adds new features',
          riskLevel: 'medium',
          recommendations: [],
          changeGroups: [],
        }),
        agenticCtx,
      );
      expect(result).toBeDefined();
      expect(result.summary).toContain('new features');
    });

    it('accepts agentic response with recommendations only', () => {
      const result = reviewService.parseReviewResponse(
        JSON.stringify({
          recommendations: [
            { type: 'issue', severity: 'high', title: 'Bug found', description: 'Desc', file: 'backend/src/services/review/reviewProviderExecution.js', line: 10 },
          ],
        }),
        agenticCtx,
      );
      expect(result).toBeDefined();
      expect(result.recommendations.length).toBeGreaterThan(0);
    });
  });
});
