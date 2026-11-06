/**
 * Byte-identity contract for the agentic prompt builder.
 *
 * - **Balanced (smart) prompt MUST stay byte-identical** — this digest
 *   pin must not change in any M1a/M1b/Section-R/later PR until a Balanced
 *   prompt change is explicitly approved.
 * - **Performance prompt** has digests pinned across two axes:
 *     1. intended-exploration mode (M1b)
 *     2. runtimeMcpEnabled (Section R Phase B). Default false matches the
 *        Phase A.0 prompt; true switches the retrieval bullet to reference
 *        the atlas-review-rt MCP tool names.
 *   Each variant is fixed so a regression in any single bullet fails loudly.
 *
 * If either Balanced changes, or any Performance variant changes
 * unintentionally, block the PR.
 *
 * The fixture is intentionally tiny so this runs in microseconds.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildCliAgenticReviewPrompt } from '../reviewProviderExecution.js';

const FIXTURE = {
  branchName: 'fixture/byte-identity',
  baseBranch: 'main',
  mergeBaseSha: '0000000000000000000000000000000000000000',
  headSha: '1111111111111111111111111111111111111111',
  fileHints: [
    { path: 'backend/src/services/foo.js', riskScore: 5 },
    { path: 'frontend/src/components/Bar.tsx', riskScore: 2 },
  ],
  ignorePatterns: [],
  outputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      riskLevel: { type: 'string' },
      recommendations: { type: 'array' },
    },
  },
  fileCount: 2,
  maxTurns: 10,
  preComputedDiff: '--- a/backend/src/services/foo.js\n+++ b/backend/src/services/foo.js\n@@ -1,2 +1,3 @@\n const x = 1;\n+const y = 2;\n',
  linterFindings: [],
  behavioralHotspotsSummary: null,
};

function digest(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

describe('M1a/M1b byte-identity contract', () => {
  it('Balanced prompt is byte-stable on the fixture diff', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'smart',
    });
    // Sanity: prompt is non-empty
    expect(prompt.length).toBeGreaterThan(100);
    // Pinned digest — bump only when an intentional Balanced prompt change ships.
    expect({
      strategy: 'smart',
      length: prompt.length,
      sha256_16: digest(prompt),
    }).toMatchInlineSnapshot(`
      {
        "length": 3973,
        "sha256_16": "a5407aaa83898039",
        "strategy": "smart",
      }
    `);
  });

  it('Performance prompt is byte-stable on the fixture diff', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'performance',
    });
    expect(prompt.length).toBeGreaterThan(100);
    // Pinned digest — bump only when M1b (or a later milestone) intentionally
    // changes the Performance prompt. M1a must not change this.
    expect({
      strategy: 'performance',
      length: prompt.length,
      sha256_16: digest(prompt),
    }).toMatchInlineSnapshot(`
      {
        "length": 6051,
        "sha256_16": "9fa296ce2adb251d",
        "strategy": "performance",
      }
    `);
  });

  it('Performance and Balanced prompts differ (sanity: gating still works)', () => {
    const balanced = buildCliAgenticReviewPrompt({ ...FIXTURE, reviewModelStrategy: 'smart' });
    const performance = buildCliAgenticReviewPrompt({ ...FIXTURE, reviewModelStrategy: 'performance' });
    expect(balanced).not.toBe(performance);
    expect(performance.length).toBeGreaterThan(balanced.length);
  });
});

describe('M1b — per-intended-mode prompt snapshots', () => {
  // Each intended mode renders one extra bullet on top of the Performance
  // baseline (anti-shell + compact-output stay constant). These snapshots
  // pin the bullet shape so an accidental wording change is caught.

  it('intendedExplorationMode=none', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'performance',
      intendedExplorationMode: 'none',
    });
    expect({
      mode: 'none',
      length: prompt.length,
      sha256_16: digest(prompt),
    }).toMatchInlineSnapshot(`
      {
        "length": 6226,
        "mode": "none",
        "sha256_16": "f4f66b96a9e8a9d6",
      }
    `);
  });

  it('intendedExplorationMode=diff_only', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'performance',
      intendedExplorationMode: 'diff_only',
    });
    expect({
      mode: 'diff_only',
      length: prompt.length,
      sha256_16: digest(prompt),
    }).toMatchInlineSnapshot(`
      {
        "length": 6218,
        "mode": "diff_only",
        "sha256_16": "790b4c2a6ef7848d",
      }
    `);
  });

  it('intendedExplorationMode=targeted_context with reasonCodes', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'performance',
      intendedExplorationMode: 'targeted_context',
      intendedExplorationModeReasons: ['public_api', 'auth_or_storage'],
    });
    expect({
      mode: 'targeted_context',
      length: prompt.length,
      sha256_16: digest(prompt),
    }).toMatchInlineSnapshot(`
      {
        "length": 6267,
        "mode": "targeted_context",
        "sha256_16": "8991684d2a97a7d8",
      }
    `);
  });

  it('intendedExplorationMode=broad_agentic', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'performance',
      intendedExplorationMode: 'broad_agentic',
    });
    expect({
      mode: 'broad_agentic',
      length: prompt.length,
      sha256_16: digest(prompt),
    }).toMatchInlineSnapshot(`
      {
        "length": 6216,
        "mode": "broad_agentic",
        "sha256_16": "8cdd1cb10a330435",
      }
    `);
  });

  it('all four mode variants produce distinct prompts', () => {
    const prompts = ['none', 'diff_only', 'targeted_context', 'broad_agentic'].map((mode) =>
      buildCliAgenticReviewPrompt({
        ...FIXTURE,
        reviewModelStrategy: 'performance',
        intendedExplorationMode: mode,
      }),
    );
    const uniq = new Set(prompts);
    expect(uniq.size).toBe(4);
  });

  it('Performance prompt under any intended mode contains the anti-shell and compact-output bullets', () => {
    for (const mode of ['none', 'diff_only', 'targeted_context', 'broad_agentic']) {
      const prompt = buildCliAgenticReviewPrompt({
        ...FIXTURE,
        reviewModelStrategy: 'performance',
        intendedExplorationMode: mode,
      });
      expect(prompt).toContain('Do NOT use Bash to enumerate the repository or run grep over many files');
      expect(prompt).toContain('Keep your response compact and grounded in evidence');
      expect(prompt).toContain('Retrieval first');
      // Phase B-3 (softened in B-6): verification rule for false-positive
      // mitigation. Targets the Codex 5.3 hallucinated-URL pattern observed
      // in PR #200 where Performance asserted a finding about a route that
      // did not exist in the code. Softened to keep candidate-class
      // findings instead of dropping them — strict drop wording was
      // missing the U1 headline cooldown bug 3/3 in Phase B benchmark.
      expect(prompt).toContain('Verify before asserting');
      expect(prompt).toContain('keep it as a candidate finding');
      expect(prompt).toContain('do not silently drop plausible correctness concerns');
      // Phase B-6: verification effort cap (subsumes B-5 anti-fragmentation).
      // Caps repeated reads at the candidate granularity rather than file.
      expect(prompt).toContain('at most one targeted context lookup per candidate');
      expect(prompt).toContain('Prefer a single bounded slice large enough');
    }
  });

  it('Balanced prompt does NOT contain the M1b/Section-R Performance bullets', () => {
    const balanced = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'smart',
      // Even if intendedExplorationMode is somehow passed in, Balanced
      // must ignore it. This protects the byte-identity contract from a
      // wiring bug.
      intendedExplorationMode: 'targeted_context',
      intendedExplorationModeReasons: ['public_api'],
    });
    expect(balanced).not.toContain('Do NOT use Bash to enumerate');
    expect(balanced).not.toContain('Keep your response compact and grounded in evidence');
    expect(balanced).not.toContain('Diff scope assessment');
    expect(balanced).not.toContain('Retrieval first');
  });
});

describe('Section R Phase B — runtimeMcpEnabled changes the retrieval bullet', () => {
  it('runtime MCP enabled: bullet references the MCP tool names by canonical name', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'performance',
      runtimeMcpEnabled: true,
    });
    expect(prompt).toContain('mcp__atlas-review-rt__get_diff_for_file');
    expect(prompt).toContain('mcp__atlas-review-rt__read_file_slice');
    expect(prompt).toContain('mcp__atlas-review-rt__get_hunk_context');
    // The Phase A.0 fallback `git diff <sha>..<sha>` invocation should NOT
    // appear when the agent has the real MCP tools — it would tell the
    // agent to do via Bash what the dedicated tool does.
    expect(prompt).not.toMatch(/git diff [0-9a-f]{4,}\.\.[0-9a-f]{4,} -- /);
  });

  it('runtime MCP enabled: anti-shell bullet forbids Bash for diffs (no carve-out)', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'performance',
      runtimeMcpEnabled: true,
    });
    expect(prompt).toContain('Do NOT use Bash to enumerate the repository, run grep over many files, or run git for diffs');
    // The Phase A.0 wording about "the targeted invocation above" is no
    // longer applicable because there's no longer a Bash invocation above.
    expect(prompt).not.toContain('reserved for the targeted invocation above');
  });

  it('runtime MCP disabled (default): Phase A.0 Bash-based bullet is rendered', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'performance',
    });
    expect(prompt).toContain('git diff 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111 -- <path>');
    expect(prompt).not.toContain('mcp__atlas-review-rt__');
  });

  it('Balanced + runtimeMcpEnabled=true still produces no Performance bullets', () => {
    // The runtime MCP plumbing must never leak into Balanced. Even when a
    // wiring bug somehow sets runtimeMcpEnabled on a Balanced call, the
    // performancePromptMode gate keeps the prompt byte-identical.
    const balanced = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'smart',
      runtimeMcpEnabled: true,
    });
    expect(balanced).not.toContain('mcp__atlas-review-rt__');
    expect(balanced).not.toContain('Retrieval first');
    expect(balanced).not.toContain('Diff scope assessment');
    expect(balanced).not.toContain('Do NOT use Bash to enumerate');
  });

  it('Performance + runtime MCP enabled prompt is byte-stable on the fixture diff', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'performance',
      runtimeMcpEnabled: true,
    });
    expect({
      strategy: 'performance',
      runtimeMcp: 'on',
      length: prompt.length,
      sha256_16: digest(prompt),
    }).toMatchInlineSnapshot(`
      {
        "length": 6412,
        "runtimeMcp": "on",
        "sha256_16": "793cd45b848fa636",
        "strategy": "performance",
      }
    `);
  });
});

describe('Section R Phase A — retrieval bullet SHA substitution', () => {
  it('Performance with both SHAs renders concrete `git diff <base>..<head>`', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      reviewModelStrategy: 'performance',
    });
    expect(prompt).toContain(`git diff ${FIXTURE.mergeBaseSha}..${FIXTURE.headSha} -- <path>`);
    expect(prompt).not.toContain('<merge-base>..<head>');
  });

  it('Performance with missing SHAs falls back to placeholder form', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      mergeBaseSha: '',
      headSha: '',
      reviewModelStrategy: 'performance',
    });
    expect(prompt).toContain('git diff <merge-base>..<head> -- <path>');
    expect(prompt).not.toContain(`${FIXTURE.mergeBaseSha}..${FIXTURE.headSha}`);
  });

  it('Performance with only one SHA still falls back to placeholder (avoid half-baked range)', () => {
    const prompt = buildCliAgenticReviewPrompt({
      ...FIXTURE,
      mergeBaseSha: '',
      reviewModelStrategy: 'performance',
    });
    expect(prompt).toContain('git diff <merge-base>..<head> -- <path>');
  });
});
