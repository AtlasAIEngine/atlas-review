import { describe, it, expect } from 'vitest';
import reviewService from '../reviewService.js';
import memoryService from '../memoryService.js';

function indexOfOrInfinity(text, marker) {
  const index = text.indexOf(marker);
  return index >= 0 ? index : Number.POSITIVE_INFINITY;
}

describe('review prompt context blocks', () => {
  it('orders local context blocks and sanitizes commit messages', () => {
    const diff = 'diff --git a/src/index.js b/src/index.js\n@@ -1,1 +1,1 @@\n-old\n+new';
    const { prompt } = reviewService.buildReviewPrompt(diff, {
      title: 'Prompt context ordering',
      commitMessages: [
        'feat: harden auth\nwith follow-up details',
        'fix: normalize headers',
      ],
      verificationStatus: {
        lint: 'pass',
        unit: 'fail',
        e2e: 'not_run',
        lastRunAt: '2026-02-22T17:00:00.000Z',
      },
      priorFindingHints: [
        {
          filePath: 'src/index.js',
          title: 'Missing authorization guard',
          severity: 'high',
          type: 'issue',
          sameHash: true,
        },
      ],
      claudeConventions: [
        'Use async/await for IO flows',
        'Keep route/controller boundaries clean',
      ],
      projectMetadata: {
        projectType: 'node',
        configFile: 'package.json',
        availableChecks: { lint: true, unit: true, e2e: false },
      },
    });

    const commitIdx = indexOfOrInfinity(prompt, '### Atlas Local Context: Commit Intent');
    const verificationIdx = indexOfOrInfinity(prompt, '### Atlas Local Context: Verification Status');
    const priorIdx = indexOfOrInfinity(prompt, '### Atlas Local Context: Prior Findings');
    const conventionsIdx = indexOfOrInfinity(prompt, '### Atlas Local Context: CLAUDE Conventions');
    const projectIdx = indexOfOrInfinity(prompt, '### Atlas Local Context: Project Metadata');

    expect(commitIdx).toBeLessThan(verificationIdx);
    expect(verificationIdx).toBeLessThan(priorIdx);
    expect(priorIdx).toBeLessThan(conventionsIdx);
    expect(conventionsIdx).toBeLessThan(projectIdx);
    expect(prompt).toContain('- feat: harden auth with follow-up details');
    expect(prompt).not.toContain('feat: harden auth\nwith follow-up details');
  });

  it('includes verification failure excerpts in prompt context when logs are available', () => {
    const diff = 'diff --git a/src/auth.js b/src/auth.js\n@@ -1,1 +1,1 @@\n-old\n+new';
    const { prompt } = reviewService.buildReviewPrompt(diff, {
      title: 'Prompt context verification excerpt',
      verificationStatus: {
        lint: 'fail',
        unit: 'pass',
        e2e: 'not_run',
        logs: {
          lint: 'src/auth.js:21 error Missing auth guard on admin route',
        },
      },
    });

    expect(prompt).toContain('Checks: lint=fail, unit=pass, e2e=not_run');
    expect(prompt).toContain('Fail excerpt (lint): src/auth.js:21 error Missing auth guard on admin route');
  });

  it('extracts CLAUDE coding conventions deterministically', () => {
    const conventions = memoryService.extractConventionsFromClaudeContent(`
# Project

## Coding Conventions
- Use async/await
- Validate inputs
- Keep services pure when possible

## Architecture
- API-first
`, {
      maxItems: 2,
    });

    expect(conventions).toEqual([
      'Use async/await',
      'Validate inputs',
    ]);
  });

  it('extracts conventions from learned code patterns section deterministically', () => {
    const conventions = memoryService.extractConventionsFromClaudeContent(`
# Project

## Code Patterns (Learned from Reviews)
- Keep regex case normalized when matching lowercased strings
- Include renamed paths from git status.renamed in file checks

## Architecture
- API-first
`, {
      maxItems: 2,
    });

    expect(conventions).toEqual([
      'Keep regex case normalized when matching lowercased strings',
      'Include renamed paths from git status.renamed in file checks',
    ]);
  });

  it('ignores Atlas-managed Claude review guidance while extracting conventions', () => {
    const conventions = memoryService.extractConventionsFromClaudeContent(`
# Project

## Coding Conventions
- Preserve user-authored conventions

<!-- atlas-review-mcp:claude:start -->
## Atlas Review (MCP)

Rules:
- Do not cancel a running review based on elapsed time alone
<!-- atlas-review-mcp:claude:end -->

## Architecture
- API-first
`, {
      maxItems: 3,
    });

    expect(conventions).toEqual([
      'Preserve user-authored conventions',
    ]);
  });

  it('defaults to same-hash-only prior finding hints', () => {
    const { contextText } = reviewService.__testing.buildBoundedPromptContextBlocks({
      priorFindingHints: [
        {
          filePath: 'src/a.ts',
          title: 'Same-hash issue',
          severity: 'high',
          type: 'issue',
          sameHash: true,
        },
        {
          filePath: 'src/b.ts',
          title: 'Stale issue',
          severity: 'critical',
          type: 'issue',
          sameHash: false,
        },
      ],
      budgetChars: 420,
    });

    expect(contextText).toContain('Same-hash issue');
    expect(contextText).not.toContain('Stale issue');
  });

  it('produces deterministic truncation telemetry for bounded context budgets', () => {
    const { contextText, telemetry } = reviewService.__testing.buildBoundedPromptContextBlocks({
      commitMessages: [
        'feat: add migration safety checks',
        'fix: remove unsafe fallback path',
        'chore: update docs',
      ],
      verificationStatus: {
        lint: 'pass',
        unit: 'fail',
        e2e: 'not_run',
        lastRunAt: '2026-02-22T17:00:00.000Z',
      },
      priorFindingHints: [
        {
          filePath: 'src/auth.ts',
          title: 'Authorization bypass on admin route',
          severity: 'critical',
          type: 'issue',
          sameHash: true,
        },
        {
          filePath: 'src/api.ts',
          title: 'Unhandled timeout branch',
          severity: 'high',
          type: 'issue',
          sameHash: true,
        },
      ],
      claudeConventions: [
        'Keep service-heavy architecture',
        'Route/API separation',
        'Prefer async/await',
      ],
      projectMetadata: {
        projectType: 'node',
        configFile: 'package.json',
        availableChecks: { lint: true, unit: true, e2e: true },
      },
      budgetChars: 180,
    });

    expect(contextText).toContain('Atlas Local Context');
    expect(telemetry.budgetChars).toBe(180);
    expect(telemetry.usedChars).toBeLessThanOrEqual(180);
    expect(telemetry.truncated).toBe(true);
    expect(telemetry.blocks.map((block) => block.id)).toEqual([
      'commit_intent',
      'verification_status',
      'prior_same_hash_findings',
      'file_risk_context',
      'claude_conventions',
      'dismissed_patterns',
      'project_metadata',
    ]);
    const verificationBlock = telemetry.blocks.find((block) => block.id === 'verification_status');
    const priorBlock = telemetry.blocks.find((block) => block.id === 'prior_same_hash_findings');
    expect(verificationBlock?.totalLines).toBeGreaterThan(0);
    expect(priorBlock?.totalLines).toBeGreaterThan(0);
    expect((verificationBlock?.omittedLines || 0) + (priorBlock?.omittedLines || 0)).toBeGreaterThan(0);
  });

  it('includes guarded historical prior findings when explicitly enabled', () => {
    const { contextText } = reviewService.__testing.buildBoundedPromptContextBlocks({
      priorFindingHints: [
        {
          filePath: 'src/security.ts',
          title: 'Historical high-risk finding',
          severity: 'critical',
          type: 'issue',
          sameHash: false,
        },
      ],
      sameHashOnly: false,
      allowGuardedCrossHashHints: true,
      budgetChars: 420,
    });

    expect(contextText).toContain('Historical high-risk finding');
    expect(contextText).toContain('[historical]');
  });

  it('renders stack-specific additional blocks in bounded prompt context', () => {
    const { prompt } = reviewService.buildReviewPrompt(
      'diff --git a/Assets/Scripts/LoginFlow.cs b/Assets/Scripts/LoginFlow.cs\n@@ -1,1 +1,1 @@\n-old\n+new',
      {
        title: 'Unity stack context prompt',
        additionalPromptContextBlocks: [
          {
            id: 'unity_stack_signals',
            title: '### Atlas Local Context: Unity Stack Signals',
            priority: 52,
            lines: [
              'Unity editor version: 6000.0.20f1',
              'Packages manifest dependencies: com.unity.addressables',
            ],
          },
        ],
      }
    );

    expect(prompt).toContain('### Atlas Local Context: Unity Stack Signals');
    expect(prompt).toContain('Unity editor version: 6000.0.20f1');
    expect(prompt).toContain('com.unity.addressables');
  });
});
