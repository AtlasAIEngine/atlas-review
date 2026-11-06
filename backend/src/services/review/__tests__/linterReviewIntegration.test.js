import { describe, expect, it } from 'vitest';
import { filterPromptLinterFindingsForFileHints } from '../linter/linterReviewIntegration.js';

describe('filterPromptLinterFindingsForFileHints', () => {
  it('keeps only findings that belong to the shard paths', () => {
    const findings = [
      { file: 'src/a.ts', line: 10, source: 'eslint', ruleId: 'no-unused-vars', message: 'a is never used' },
      { file: 'src/b.ts', line: 20, source: 'eslint', ruleId: 'no-console', message: 'Unexpected console statement' },
      { file: 'src/c.ts', line: 30, source: 'eslint', ruleId: 'eqeqeq', message: 'Expected === and instead saw ==' },
    ];

    const filtered = filterPromptLinterFindingsForFileHints(findings, [
      { path: 'src/a.ts', memberPaths: ['src/a.ts', 'src/a.test.ts'] },
      { path: 'src/b.ts', oldPath: 'src/legacy-b.ts' },
    ]);

    expect(filtered).toEqual([findings[0], findings[1]]);
  });

  it('matches suffix-equivalent paths from grouped review hints', () => {
    const findings = [
      { file: 'backend/src/server.js', line: 15, source: 'eslint', ruleId: 'no-console', message: 'Unexpected console statement' },
    ];

    const filtered = filterPromptLinterFindingsForFileHints(findings, [
      { path: 'src/server.js', memberPaths: ['src/server.js'] },
    ]);

    expect(filtered).toEqual(findings);
  });
});
