import { describe, it, expect } from 'vitest';
import reviewEvidenceValidator from '../reviewEvidenceValidator.js';

const SAMPLE_DIFF = `diff --git a/src/auth.js b/src/auth.js
@@ -10,2 +10,4 @@
-const allow = true;
+const allow = false;
+const password = input;
+return sanitize(password);
`;

const DELETION_ONLY_DIFF = `diff --git a/src/auth.js b/src/auth.js
@@ -10,2 +10,0 @@
-const allow = true;
-return validate();
`;

describe('reviewEvidenceValidator', () => {
  it('fails grounding when issue file is outside review scope', () => {
    const result = reviewEvidenceValidator.validateIssueEvidence({
      type: 'issue',
      file: 'src/other.js',
      line: 11,
      description: 'Potential auth bypass',
    }, {
      diffText: SAMPLE_DIFF,
      allowedFilePaths: ['src/auth.js'],
    });

    expect(result.grounded).toBe(false);
    expect(result.reasonCodes).toContain('file_out_of_scope');
  });

  it('fails grounding when issue line is outside changed hunk range', () => {
    const result = reviewEvidenceValidator.validateIssueEvidence({
      type: 'issue',
      file: 'src/auth.js',
      line: 200,
      description: 'Invalid line anchor',
    }, {
      diffText: SAMPLE_DIFF,
      allowedFilePaths: ['src/auth.js'],
    });

    expect(result.grounded).toBe(false);
    expect(result.reasonCodes).toContain('line_out_of_range');
  });

  it('uses evidence snippet matching to ground issue anchors', () => {
    const grounded = reviewEvidenceValidator.validateIssueEvidence({
      type: 'issue',
      file: 'src/auth.js',
      line: null,
      evidenceSnippet: 'sanitize(password)',
      description: 'Sensitive value should be scrubbed',
    }, {
      diffText: SAMPLE_DIFF,
      allowedFilePaths: ['src/auth.js'],
    });
    const ungrounded = reviewEvidenceValidator.validateIssueEvidence({
      type: 'issue',
      file: 'src/auth.js',
      line: null,
      evidenceSnippet: 'nonexistent_token',
      description: 'This snippet is not in the patch',
    }, {
      diffText: SAMPLE_DIFF,
      allowedFilePaths: ['src/auth.js'],
    });

    expect(grounded.grounded).toBe(true);
    expect(ungrounded.grounded).toBe(false);
    expect(ungrounded.reasonCodes).toContain('snippet_not_found');
  });

  it('supports atlas_review_result.v2 nested evidence anchors', () => {
    const result = reviewEvidenceValidator.validateIssueEvidence({
      type: 'issue',
      evidence: {
        file: 'src/auth.js',
        line: 11,
        snippet: 'sanitize(password)',
      },
      description: 'Nested evidence payload from v2 contract',
    }, {
      diffText: SAMPLE_DIFF,
      allowedFilePaths: ['src/auth.js'],
    });

    expect(result.grounded).toBe(true);
    expect(result.reasonCodes).toEqual([]);
  });

  it('accepts deletion-only hunks as valid line anchors', () => {
    const result = reviewEvidenceValidator.validateIssueEvidence({
      type: 'issue',
      file: 'src/auth.js',
      line: 10,
      description: 'Auth check removed from deleted line',
    }, {
      diffText: DELETION_ONLY_DIFF,
      allowedFilePaths: ['src/auth.js'],
    });

    expect(result.grounded).toBe(true);
    expect(result.reasonCodes).toEqual([]);
  });

  it('treats non-numeric line anchors as invalid without coercing to line 0', () => {
    const result = reviewEvidenceValidator.validateIssueEvidence({
      type: 'issue',
      file: 'src/auth.js',
      line: 'abc',
      description: 'Invalid anchor formatting',
    }, {
      diffText: SAMPLE_DIFF,
      allowedFilePaths: ['src/auth.js'],
    });

    expect(result.grounded).toBe(false);
    expect(result.reasonCodes).toContain('line_invalid');
    expect(result.line).toBeNull();
  });

  it('applies demote policy to ungrounded issues with explicit reason codes', () => {
    const review = {
      summary: 'Auth update',
      riskLevel: 'high',
      changeGroups: [],
      recommendations: [
        {
          type: 'issue',
          severity: 'high',
          title: 'Ungrounded finding',
          description: 'No file anchor',
          file: null,
          line: null,
        },
      ],
      stats: {},
    };

    const result = reviewEvidenceValidator.applyEvidencePolicyToReview(review, {
      diffText: SAMPLE_DIFF,
      allowedFilePaths: ['src/auth.js'],
      policy: 'demote',
    });

    expect(result.review.recommendations).toHaveLength(1);
    expect(result.review.recommendations[0].type).toBe('suggestion');
    expect(result.review.recommendations[0].grounding.reasonCodes).toContain('file_missing');
    expect(result.stats.issuesTotal).toBe(1);
    expect(result.stats.issuesGrounded).toBe(0);
    expect(result.stats.issuesDemoted).toBe(1);
    expect(result.stats.issuesSuppressed).toBe(0);
  });

  it('applies suppress policy to ungrounded issues', () => {
    const review = {
      summary: 'Auth update',
      riskLevel: 'high',
      changeGroups: [],
      recommendations: [
        {
          type: 'issue',
          severity: 'high',
          title: 'Ungrounded finding',
          description: 'No file anchor',
          file: null,
          line: null,
        },
        {
          type: 'suggestion',
          severity: 'low',
          title: 'Legit suggestion',
          description: 'Still keep this one',
          file: 'src/auth.js',
          line: 10,
        },
      ],
      stats: {},
    };

    const result = reviewEvidenceValidator.applyEvidencePolicyToReview(review, {
      diffText: SAMPLE_DIFF,
      allowedFilePaths: ['src/auth.js'],
      policy: 'suppress',
    });

    expect(result.review.recommendations).toHaveLength(1);
    expect(result.review.recommendations[0].title).toBe('Legit suggestion');
    expect(result.stats.issuesTotal).toBe(1);
    expect(result.stats.issuesGrounded).toBe(0);
    expect(result.stats.issuesDemoted).toBe(0);
    expect(result.stats.issuesSuppressed).toBe(1);
  });
});
