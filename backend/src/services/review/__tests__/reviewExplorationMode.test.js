import { describe, it, expect } from 'vitest';
import {
  classifyExplorationMode,
  resolveIntendedExplorationMode,
  reconcileExplorationMode,
  buildIntendedExplorationModeSignals,
} from '../reviewExplorationMode.js';

// Helper: build a complete telemetry snapshot with sane defaults so each test
// only states the fields it cares about.
function tt(overrides = {}) {
  return {
    toolCalls: 0,
    fullFileReads: 0,
    partialFileReads: 0,
    gitDiffCalls: 0,
    repeatedReadsTotal: 0,
    uniqueFilesRead: 0,
    classifiedCounts: { grep: 0 },
    ...overrides,
    classifiedCounts: { grep: 0, ...(overrides.classifiedCounts || {}) },
  };
}

describe('classifyExplorationMode', () => {
  it('returns null when telemetry is missing', () => {
    expect(classifyExplorationMode({})).toBeNull();
    expect(classifyExplorationMode({ toolUseTelemetry: null })).toBeNull();
    expect(classifyExplorationMode({ toolUseTelemetry: 'string' })).toBeNull();
  });

  it('returns "none" when no tool calls were made', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 0 }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('none');
  });

  it('classifies as "broad_agentic" on any full file read', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 5, fullFileReads: 1, partialFileReads: 4 }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('broad_agentic');
  });

  it('classifies as "broad_agentic" on any git_diff call', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 3, gitDiffCalls: 1, partialFileReads: 2 }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('broad_agentic');
  });

  it('classifies as "broad_agentic" on excessive repeated reads', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 10, partialFileReads: 10, repeatedReadsTotal: 6 }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('broad_agentic');
  });

  it('classifies as "broad_agentic" when uniqueFilesRead overshoots changedFiles + 4', () => {
    // 6 changed + 5 extra = 11 unique (> 6+4=10) → broad
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 11, partialFileReads: 11, uniqueFilesRead: 11 }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('broad_agentic');
  });

  it('classifies as "broad_agentic" when combined lookups exceed threshold', () => {
    expect(classifyExplorationMode({
      // 8 partial + 5 grep = 13 > 12 → broad
      toolUseTelemetry: tt({ toolCalls: 13, partialFileReads: 8, classifiedCounts: { grep: 5 }, uniqueFilesRead: 5 }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('broad_agentic');
  });

  it('classifies as "diff_only" when reads are bounded and stay within half the changed-file scope', () => {
    // 6 changed; ceil(6 * 0.5) = 3; uniqueFilesRead 3 ≤ 3
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 3, partialFileReads: 3, uniqueFilesRead: 3 }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('diff_only');
  });

  it('classifies as "targeted_context" when uniqueFilesRead exceeds the diff_only ratio but stays under broad threshold', () => {
    // 6 changed; ceil(6*0.5)=3; uniqueFilesRead 5 > 3 but ≤ 6+4=10
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 5, partialFileReads: 5, uniqueFilesRead: 5 }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('targeted_context');
  });

  it('precedence: broad_agentic wins over targeted_context indicators', () => {
    // would be targeted_context except for the full file read
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 5, partialFileReads: 4, fullFileReads: 1, uniqueFilesRead: 5 }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('broad_agentic');
  });

  it('precedence: targeted_context wins over diff_only when uniqueFilesRead exceeds the ratio', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 4, partialFileReads: 4, uniqueFilesRead: 4 }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('targeted_context');
  });

  it('handles missing shapedScope (treats changedFiles as 0)', () => {
    // 0 changed; ceil(0*0.5) = 0; uniqueFilesRead 1 > 0 → targeted_context
    // but uniqueFilesRead 1 also vs threshold 0+4=4, so not broad
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 1, partialFileReads: 1, uniqueFilesRead: 1 }),
    })).toBe('targeted_context');
  });

  it('handles toolCalls > 0 with no read/grep activity → none (defensive)', () => {
    // some weird Bash-only run with no reads
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({ toolCalls: 1, partialFileReads: 0, classifiedCounts: { grep: 0 } }),
      shapedScope: { rawFileCount: 6 },
    })).toBe('none');
  });

  it('reproduces M0 B1 Balanced shape (real captured data) → broad_agentic', () => {
    // 8 partial + 5 grep = 13 combined lookups (> 12 threshold).
    // That's the agent re-reading 4 files repeatedly = broad reasoning.
    expect(classifyExplorationMode({
      toolUseTelemetry: {
        toolCalls: 13,
        fullFileReads: 0,
        partialFileReads: 8,
        gitDiffCalls: 0,
        repeatedReadsTotal: 4,
        uniqueFilesRead: 4,
        classifiedCounts: { grep: 5 },
      },
      shapedScope: { rawFileCount: 6 },
    })).toBe('broad_agentic');
  });

  it('reproduces M0 B3 Balanced shape (real captured data) → diff_only', () => {
    // 7 partial + 1 grep = 8 combined (< 12 broad threshold).
    // 9 changed files → diff_only cap = ceil(9 * 0.5) = 5; uniqueFilesRead=4 ≤ 5 → diff_only.
    expect(classifyExplorationMode({
      toolUseTelemetry: {
        toolCalls: 8,
        fullFileReads: 0,
        partialFileReads: 7,
        gitDiffCalls: 0,
        repeatedReadsTotal: 3,
        uniqueFilesRead: 4,
        classifiedCounts: { grep: 1 },
      },
      shapedScope: { rawFileCount: 9 },
    })).toBe('diff_only');
  });

  it('reproduces M0 B2 Balanced shape (no exploration)', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: {
        toolCalls: 0,
        fullFileReads: 0,
        partialFileReads: 0,
        gitDiffCalls: 0,
        repeatedReadsTotal: 0,
        uniqueFilesRead: 0,
        classifiedCounts: { grep: 0 },
      },
      shapedScope: { rawFileCount: 8 },
    })).toBe('none');
  });
});

describe('classifyExplorationMode — shell_heavy (M1b)', () => {
  it('classifies as shell_heavy when ≥5 shell calls and zero reads/greps', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({
        toolCalls: 5,
        partialFileReads: 0,
        classifiedCounts: { grep: 0, shell: 5 },
      }),
      shapedScope: { rawFileCount: 9 },
    })).toBe('shell_heavy');
  });

  it('reproduces M0 B3 Performance run-2 → shell_heavy under M1b classifier', () => {
    // The actual run that motivated shell_heavy. 21 shell, 0 reads, 0 greps.
    // Pre-M1b classifier returned `none`; M1b classifier should return shell_heavy.
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({
        toolCalls: 21,
        partialFileReads: 0,
        fullFileReads: 0,
        gitDiffCalls: 0,
        classifiedCounts: { grep: 0, shell: 21 },
      }),
      shapedScope: { rawFileCount: 9 },
    })).toBe('shell_heavy');
  });

  it('shell calls below threshold (4) classifies as none, not shell_heavy', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({
        toolCalls: 4,
        classifiedCounts: { grep: 0, shell: 4 },
      }),
      shapedScope: { rawFileCount: 9 },
    })).toBe('none');
  });

  it('mixed shell + read activity does NOT classify as shell_heavy', () => {
    // 6 shell + 1 partial read → not shell_heavy (combinedLookups != 0).
    // Falls through to diff_only/targeted_context branch.
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({
        toolCalls: 7,
        partialFileReads: 1,
        uniqueFilesRead: 1,
        classifiedCounts: { grep: 0, shell: 6 },
      }),
      shapedScope: { rawFileCount: 9 },
    })).toBe('diff_only');
  });

  it('mixed shell + grep activity does NOT classify as shell_heavy', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({
        toolCalls: 8,
        uniqueFilesRead: 0,
        classifiedCounts: { grep: 2, shell: 6 },
      }),
      shapedScope: { rawFileCount: 9 },
    })).toBe('diff_only');
  });

  it('shell calls + Edit disqualifies from shell_heavy (intentional code mod)', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({
        toolCalls: 8,
        classifiedCounts: { grep: 0, shell: 7, edit: 1 },
      }),
      shapedScope: { rawFileCount: 9 },
    })).toBe('none');
  });

  it('shell calls + Write disqualifies from shell_heavy', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({
        toolCalls: 8,
        classifiedCounts: { grep: 0, shell: 7, write: 1 },
      }),
      shapedScope: { rawFileCount: 9 },
    })).toBe('none');
  });

  it('precedence: broad_agentic wins over shell_heavy when full reads present', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({
        toolCalls: 7,
        fullFileReads: 1,
        classifiedCounts: { grep: 0, shell: 6 },
      }),
      shapedScope: { rawFileCount: 9 },
    })).toBe('broad_agentic');
  });

  it('precedence: git_diff still wins over shell_heavy', () => {
    expect(classifyExplorationMode({
      toolUseTelemetry: tt({
        toolCalls: 8,
        gitDiffCalls: 1,
        classifiedCounts: { grep: 0, shell: 7 },
      }),
      shapedScope: { rawFileCount: 9 },
    })).toBe('broad_agentic');
  });
});

describe('resolveIntendedExplorationMode', () => {
  it('returns null for Balanced (smart)', () => {
    expect(resolveIntendedExplorationMode('smart', { isDocOnly: true })).toBeNull();
  });

  it('returns null for unknown strategies', () => {
    expect(resolveIntendedExplorationMode('latency_first', {})).toBeNull();
    expect(resolveIntendedExplorationMode(null, {})).toBeNull();
    expect(resolveIntendedExplorationMode(undefined, {})).toBeNull();
  });

  it('escalates to broad_agentic on hasHighRiskSignals', () => {
    const r = resolveIntendedExplorationMode('performance', { hasHighRiskSignals: true });
    expect(r.mode).toBe('broad_agentic');
    expect(r.reasonCodes).toContain('high_risk_signals');
  });

  it('escalates to broad_agentic on auth_or_storage + large blast radius', () => {
    const r = resolveIntendedExplorationMode('performance', {
      touchesAuthOrStorage: true,
      largeBlastRadius: true,
    });
    expect(r.mode).toBe('broad_agentic');
    expect(r.reasonCodes).toEqual(['auth_or_storage', 'large_blast_radius']);
  });

  it('targeted_context: candidate findings present', () => {
    const r = resolveIntendedExplorationMode('performance', { candidateFindingsCount: 2 });
    expect(r.mode).toBe('targeted_context');
    expect(r.reasonCodes).toContain('candidate_findings');
  });

  it('targeted_context: linter findings present', () => {
    const r = resolveIntendedExplorationMode('performance', { linterFindingsCount: 1 });
    expect(r.mode).toBe('targeted_context');
    expect(r.reasonCodes).toContain('linter_findings');
  });

  it('targeted_context: hotspots present', () => {
    const r = resolveIntendedExplorationMode('performance', { hotspotsPresent: true });
    expect(r.mode).toBe('targeted_context');
    expect(r.reasonCodes).toContain('hotspots');
  });

  it('targeted_context: public API touched', () => {
    const r = resolveIntendedExplorationMode('performance', { touchesPublicApi: true });
    expect(r.mode).toBe('targeted_context');
    expect(r.reasonCodes).toContain('public_api');
  });

  it('targeted_context: auth or storage touched (without large blast radius)', () => {
    const r = resolveIntendedExplorationMode('performance', { touchesAuthOrStorage: true });
    expect(r.mode).toBe('targeted_context');
    expect(r.reasonCodes).toEqual(['auth_or_storage']);
  });

  it('targeted_context: lifecycle touched', () => {
    const r = resolveIntendedExplorationMode('performance', { touchesLifecycle: true });
    expect(r.mode).toBe('targeted_context');
    expect(r.reasonCodes).toContain('lifecycle');
  });

  it('targeted_context: dependency touched', () => {
    const r = resolveIntendedExplorationMode('performance', { touchesDependency: true });
    expect(r.mode).toBe('targeted_context');
    expect(r.reasonCodes).toContain('dependency');
  });

  it('targeted_context: migration touched', () => {
    const r = resolveIntendedExplorationMode('performance', { touchesMigration: true });
    expect(r.mode).toBe('targeted_context');
    expect(r.reasonCodes).toContain('migration');
  });

  it('targeted_context: risky config touched', () => {
    const r = resolveIntendedExplorationMode('performance', { touchesRiskyConfig: true });
    expect(r.mode).toBe('targeted_context');
    expect(r.reasonCodes).toContain('config_touched');
  });

  it('none: doc-only diff with no risk keywords', () => {
    const r = resolveIntendedExplorationMode('performance', { isDocOnly: true });
    expect(r.mode).toBe('none');
    expect(r.reasonCodes).toContain('doc_only');
  });

  it('none: asset-only diff', () => {
    const r = resolveIntendedExplorationMode('performance', { isAssetOnly: true });
    expect(r.mode).toBe('none');
    expect(r.reasonCodes).toContain('asset_only');
  });

  it('doc-only with risk keywords escalates from none to diff_only', () => {
    const r = resolveIntendedExplorationMode('performance', {
      isDocOnly: true,
      hasRiskKeywords: true,
    });
    expect(r.mode).toBe('diff_only');
  });

  it('default for code change with no signals: diff_only', () => {
    const r = resolveIntendedExplorationMode('performance', {});
    expect(r.mode).toBe('diff_only');
    expect(r.reasonCodes).toEqual(['low_medium_risk_code_change']);
  });

  it('precedence: targeted_context wins over none when both signals present', () => {
    // doc-only would normally be `none`, but candidate findings escalate to targeted
    const r = resolveIntendedExplorationMode('performance', {
      isDocOnly: true,
      candidateFindingsCount: 1,
    });
    expect(r.mode).toBe('targeted_context');
  });

  it('aggregates multiple targeted reason codes', () => {
    const r = resolveIntendedExplorationMode('performance', {
      candidateFindingsCount: 1,
      hotspotsPresent: true,
      touchesAuthOrStorage: true,
    });
    expect(r.mode).toBe('targeted_context');
    expect(r.reasonCodes).toEqual(['candidate_findings', 'hotspots', 'auth_or_storage']);
  });

  it('null signals input is handled safely (defaults to diff_only for performance)', () => {
    expect(resolveIntendedExplorationMode('performance', null).mode).toBe('diff_only');
    expect(resolveIntendedExplorationMode('performance').mode).toBe('diff_only');
  });
});

describe('buildIntendedExplorationModeSignals', () => {
  it('docs-only diff', () => {
    const s = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'README.md' }, { path: 'docs/setup.md' }],
    });
    expect(s.isDocOnly).toBe(true);
    expect(s.isAssetOnly).toBe(false);
    expect(s.isConfigOnly).toBe(false);
    expect(s.hasRiskKeywords).toBe(false);
  });

  it('asset-only diff', () => {
    const s = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'assets/logo.svg' }, { path: 'public/banner.png' }],
    });
    expect(s.isAssetOnly).toBe(true);
    expect(s.isDocOnly).toBe(false);
  });

  it('config-only diff (mixed config + docs) stays non-risky for standard tool config', () => {
    const s = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'tsconfig.json' }, { path: 'vite.config.ts' }, { path: 'README.md' }],
    });
    expect(s.isConfigOnly).toBe(true);
    expect(s.touchesConfig).toBe(true);
    expect(s.touchesRiskyConfig).toBe(false);
    const decision = resolveIntendedExplorationMode('performance', s);
    expect(decision.mode).toBe('none');
    expect(decision.reasonCodes).toContain('config_only_no_risk');
  });

  it('detects risky config separately from standard config files', () => {
    const s = buildIntendedExplorationModeSignals({
      fileHints: [{ path: '.env.production' }],
    });
    expect(s.isConfigOnly).toBe(true);
    expect(s.touchesConfig).toBe(true);
    expect(s.touchesRiskyConfig).toBe(true);
    const decision = resolveIntendedExplorationMode('performance', s);
    expect(decision.mode).toBe('targeted_context');
    expect(decision.reasonCodes).toContain('config_touched');
  });

  it('detects dependency manifests', () => {
    const s = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'package.json' }, { path: 'src/foo.ts' }],
    });
    expect(s.touchesDependency).toBe(true);
    expect(s.isConfigOnly).toBe(false);
  });

  it('detects migrations and auth-or-storage', () => {
    const s = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'backend/migrations/001_add_users.sql' }],
    });
    expect(s.touchesMigration).toBe(true);
    expect(s.touchesAuthOrStorage).toBe(true);
  });

  it('detects public API surface', () => {
    const s1 = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'backend/src/routes/users.js' }],
    });
    expect(s1.touchesPublicApi).toBe(true);

    const s2 = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'schema.graphql' }],
    });
    expect(s2.touchesPublicApi).toBe(true);
  });

  it('detects auth/storage paths', () => {
    const s = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'backend/src/services/authService.js' }],
    });
    expect(s.touchesAuthOrStorage).toBe(true);
    expect(s.hasRiskKeywords).toBe(true);
  });

  it('detects lifecycle keywords in path', () => {
    const s = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'frontend/src/hooks/useEffectExample.ts' }],
    });
    expect(s.touchesLifecycle).toBe(true);
  });

  it('counts linter findings and detects critical severity as high-risk', () => {
    const s = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'src/foo.ts' }],
      linterFindings: [
        { severity: 'high' },
        { severity: 'low' },
      ],
    });
    expect(s.linterFindingsCount).toBe(2);
    expect(s.hasHighRiskSignals).toBe(true);
  });

  it('hotspotsPresent reflects behavioralHotspots.summary', () => {
    expect(buildIntendedExplorationModeSignals({
      behavioralHotspots: { summary: 'auth.js touched 7x' },
    }).hotspotsPresent).toBe(true);
    expect(buildIntendedExplorationModeSignals({
      behavioralHotspots: { summary: '' },
    }).hotspotsPresent).toBe(false);
    expect(buildIntendedExplorationModeSignals({}).hotspotsPresent).toBe(false);
  });

  it('passes through largeBlastRadius and candidateFindingsCount', () => {
    const s = buildIntendedExplorationModeSignals({
      largeBlastRadius: true,
      candidateFindingsCount: 3,
    });
    expect(s.largeBlastRadius).toBe(true);
    expect(s.candidateFindingsCount).toBe(3);
  });

  it('end-to-end: signals → resolver produces expected mode for code change', () => {
    const signals = buildIntendedExplorationModeSignals({
      fileHints: [
        { path: 'backend/src/services/reviewService.js' },
        { path: 'frontend/src/components/Foo.tsx' },
      ],
    });
    const decision = resolveIntendedExplorationMode('performance', signals);
    expect(decision.mode).toBe('diff_only');
  });

  it('end-to-end: auth touch escalates to targeted_context', () => {
    const signals = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'backend/src/middleware/authMiddleware.js' }],
    });
    const decision = resolveIntendedExplorationMode('performance', signals);
    expect(decision.mode).toBe('targeted_context');
    expect(decision.reasonCodes).toContain('auth_or_storage');
  });

  it('end-to-end: docs-only stays at none', () => {
    const signals = buildIntendedExplorationModeSignals({
      fileHints: [{ path: 'README.md' }, { path: 'CHANGELOG.md' }],
    });
    const decision = resolveIntendedExplorationMode('performance', signals);
    expect(decision.mode).toBe('none');
  });
});

describe('reconcileExplorationMode', () => {
  it('reconciled when intended === observed', () => {
    expect(reconcileExplorationMode('diff_only', 'diff_only'))
      .toEqual({ reconciled: true, drift: null });
  });

  it('drift set when intended differs from observed', () => {
    expect(reconcileExplorationMode('diff_only', 'targeted_context'))
      .toEqual({ reconciled: false, drift: { intended: 'diff_only', observed: 'targeted_context' } });
  });

  it('not reconciled when intended is null (Balanced)', () => {
    expect(reconcileExplorationMode(null, 'broad_agentic'))
      .toEqual({ reconciled: false, drift: null });
  });

  it('not reconciled when observed is null (telemetry missing)', () => {
    expect(reconcileExplorationMode('diff_only', null))
      .toEqual({ reconciled: false, drift: null });
  });
});
