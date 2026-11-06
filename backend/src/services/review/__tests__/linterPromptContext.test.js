import { describe, expect, it } from 'vitest';
import { normalizeLinterFindingsBlockLines, buildPromptContextBlockDefinitions } from '../reviewPromptContext.js';

describe('normalizeLinterFindingsBlockLines', () => {
  const findings = [
    { source: 'eslint', severity: 'high', file: 'src/auth.ts', line: 10, ruleId: 'security/no-eval', message: 'Avoid eval()' },
    { source: 'eslint', severity: 'low', file: 'src/utils.ts', line: 5, ruleId: 'no-unused-vars', message: 'x is never used' },
    { source: 'tsc', severity: 'medium', file: 'src/app.ts', line: 20, ruleId: 'TS2345', message: 'Type mismatch' },
  ];

  it('formats findings as compact lines', () => {
    const lines = normalizeLinterFindingsBlockLines(findings);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('eslint');
    expect(lines[0]).toContain('[high]');
    expect(lines[0]).toContain('src/auth.ts:10');
  });

  it('sorts by severity (highest first)', () => {
    const lines = normalizeLinterFindingsBlockLines(findings);
    expect(lines[0]).toContain('[high]');
    expect(lines[1]).toContain('[medium]');
    expect(lines[2]).toContain('[low]');
  });

  it('respects maxItems limit', () => {
    const lines = normalizeLinterFindingsBlockLines(findings, { maxItems: 2 });
    expect(lines).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeLinterFindingsBlockLines([])).toEqual([]);
    expect(normalizeLinterFindingsBlockLines(null)).toEqual([]);
  });

  it('truncates long lines', () => {
    const longFinding = { ...findings[0], message: 'A'.repeat(500) };
    const lines = normalizeLinterFindingsBlockLines([longFinding], { maxCharsPerLine: 100 });
    expect(lines[0].length).toBeLessThanOrEqual(100);
    expect(lines[0]).toContain('...');
  });

  it('includes compact local verification evidence when present', () => {
    const lines = normalizeLinterFindingsBlockLines([{
      ...findings[0],
      evidenceSummary: 'production path; runtime-capable asmdef Assets/Scripts/Gameplay/Gameplay.Runtime.asmdef',
      promptEvidenceSummary: 'runtime service, runtime asmdef, 1 runtime ref',
    }]);
    expect(lines[0]).toContain('| local: runtime service, runtime asmdef, 1 runtime ref');
  });
});

describe('buildPromptContextBlockDefinitions with linterFindings', () => {
  it('includes linter_findings block when findings are provided', () => {
    const findings = [
      { source: 'eslint', severity: 'medium', file: 'a.ts', line: 1, ruleId: 'x', message: 'test' },
    ];
    const blocks = buildPromptContextBlockDefinitions({ linterFindings: findings });
    const linterBlock = blocks.find((b) => b.id === 'linter_findings');
    expect(linterBlock).toBeDefined();
    expect(linterBlock.lines).toHaveLength(1);
    expect(linterBlock.title).toContain('Deterministic');
  });

  it('omits linter_findings block when no findings', () => {
    const blocks = buildPromptContextBlockDefinitions({ linterFindings: [] });
    const linterBlock = blocks.find((b) => b.id === 'linter_findings');
    expect(linterBlock).toBeUndefined();
  });
});
