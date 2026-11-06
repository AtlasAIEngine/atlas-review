import { describe, expect, it } from 'vitest';

import { buildRenderedDiffLineIndex, parseReviewResponse } from '../reviewPromptBuilder.js';

describe('buildRenderedDiffLineIndex', () => {
  it('ignores blank separator lines outside hunks', () => {
    const diff = [
      'diff --git a/src/example.ts b/src/example.ts',
      'index abc..def 100644',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '',
      '@@ -1,2 +1,2 @@',
      ' context',
      '+added',
    ].join('\n');

    const index = buildRenderedDiffLineIndex(diff);
    expect(index.get('src/example.ts')?.renderedNewLines).toEqual([
      { line: 1, content: 'context' },
      { line: 2, content: 'added' },
    ]);
  });
});

describe('parseReviewResponse candidateFindings', () => {
  it('marks strict JSON as an unrecovered parse', () => {
    const response = JSON.stringify({
      summary: 'Structured review payload.',
      riskLevel: 'medium',
      changeGroups: [],
      recommendations: [],
      candidateFindings: [],
    });

    const parsed = parseReviewResponse(response, { agenticMode: true });

    expect(parsed.stats.parseMode).toBe('strict_json');
    expect(parsed.stats.parseRecovered).toBe(false);
  });

  it('accepts agentic responses that contain only candidate findings', () => {
    const response = JSON.stringify({
      summary: '',
      riskLevel: 'medium',
      changeGroups: [],
      recommendations: [],
      candidateFindings: [
        {
          type: 'issue',
          severity: 'medium',
          confidence: 'medium',
          title: 'Possible init ordering regression',
          description: 'Signal subscription moved and may miss the first dispatch.',
          file: 'src/view.ts',
          line: 12,
          evidence: {
            file: 'src/view.ts',
            line: 12,
            snippet: 'start();',
            reasoning: 'Initialization moved later in lifecycle.',
          },
        },
      ],
      stats: {},
    });

    const parsed = parseReviewResponse(response, { agenticMode: true });
    expect(parsed.recommendations).toEqual([]);
    expect(parsed.candidateFindings).toHaveLength(1);
    expect(parsed.candidateFindings[0]).toMatchObject({
      title: 'Possible init ordering regression',
      confidence: 'medium',
      type: 'issue',
    });
    expect(parsed.stats.candidateFindingsCount).toBe(1);
  });

  it('salvages terminal-style review sections without requiring JSON', () => {
    const response = [
      'Summary:',
      'This PR has one grounded issue and one plausible follow-up concern.',
      '',
      'Overall risk: high',
      '',
      'Issues:',
      '- [high] Missing null guard before mask update',
      '  file: Assets/BLACK/MiniMap/Scripts/View/MiniMapMask.cs',
      '  line: 87',
      '  why: UpdateMask dereferences the shared mask without checking initialization.',
      '  snippet: _miniMapMask.UpdateMask()',
      '  fix: Guard the mask before invoking UpdateMask.',
      '',
      'Candidate concerns:',
      '- [medium] Timer text is still hardcoded',
      '  file: Assets/BLACK/MiniMap/Scripts/View/GameEventsTimerMapView.cs',
      '  line: 93',
      '  why: The timer still renders an English storm string directly.',
      '  snippet: "Storm is closing"',
      '  fix: Route the message through localization.',
    ].join('\n');

    const parsed = parseReviewResponse(response, { agenticMode: true });

    expect(parsed.summary).toContain('grounded issue');
    expect(parsed.riskLevel).toBe('high');
    expect(parsed.recommendations).toHaveLength(1);
    expect(parsed.recommendations[0]).toMatchObject({
      title: 'Missing null guard before mask update',
      file: 'Assets/BLACK/MiniMap/Scripts/View/MiniMapMask.cs',
      line: 87,
      severity: 'high',
    });
    expect(parsed.candidateFindings).toHaveLength(1);
    expect(parsed.candidateFindings[0].type).toBe('suggestion');
    expect(parsed.stats.parseMode).toBe('section_salvage');
    expect(parsed.stats.parseRecovered).toBe(true);
  });

  it('treats fenced JSON as a normal parse, not a recovered one', () => {
    const response = [
      '```json',
      JSON.stringify({
        summary: 'Structured review payload.',
        riskLevel: 'medium',
        changeGroups: [],
        recommendations: [],
        candidateFindings: [],
      }),
      '```',
    ].join('\n');

    const parsed = parseReviewResponse(response, { agenticMode: true });

    expect(parsed.summary).toContain('Structured review payload');
    expect(parsed.stats.parseMode).toBe('fenced_json');
    expect(parsed.stats.parseRecovered).toBe(false);
  });

  it('marks repaired JSON as recovered without falling through to salvage tiers', () => {
    const response = '{"summary":"Recovered malformed JSON","riskLevel":"medium","recommendations":[{"type":"issue","severity":"medium","title":"First finding","description":"One","file":"src/one.ts"} {"type":"issue","severity":"low","title":"Second finding","description":"Two","file":"src/two.ts"}],"candidateFindings":[]}';

    const parsed = parseReviewResponse(response, { agenticMode: true });

    expect(parsed.summary).toBe('Recovered malformed JSON');
    expect(parsed.recommendations).toHaveLength(2);
    expect(parsed.stats.parseMode).toBe('repaired_json');
    expect(parsed.stats.parseRecovered).toBe(true);
  });

  it('recovers longer free-form prose into a minimal fallback review', () => {
    const response = 'The review found a likely regression in initialization ordering, but the output wrapper returned prose instead of JSON. The timer may miss an early signal dispatch and should be checked against the PR diff before publishing comments.';

    const parsed = parseReviewResponse(response, { agenticMode: true });

    expect(parsed.summary).toContain('likely regression');
    expect(parsed.recommendations).toEqual([]);
    expect(parsed.candidateFindings).toEqual([]);
    expect(parsed.stats.parseMode).toBe('minimal_fallback');
    expect(parsed.stats.parseRecovered).toBe(true);
  });

  it('extracts and unescapes the summary field when minimal fallback runs on malformed JSON', () => {
    const response = '{"summary":"- claudeBinary.js: switches from execFileSync to execFileAsync to remove a thread-blocking probe at startup.\\n- branchReviews.js: adds a pinned base-branch early return so a user-pinned base takes precedence.\\n- TrustReviewView.tsx: adds null-safety guard around ensured?.branchName usage.","riskLevel":"medium","recommendations":[';

    const parsed = parseReviewResponse(response, { agenticMode: true });

    expect(parsed.stats.parseMode).toBe('minimal_fallback');
    expect(parsed.summary.startsWith('{"summary"')).toBe(false);
    expect(parsed.summary).toContain('claudeBinary.js');
    expect(parsed.summary).toContain('\n- branchReviews.js');
    expect(parsed.summary).not.toContain('\\n');
    expect(parsed.riskLevel).toBe('medium');
  });
});
