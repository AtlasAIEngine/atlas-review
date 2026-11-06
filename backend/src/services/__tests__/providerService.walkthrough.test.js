/**
 * providerService — walkthrough-phase model resolution.
 *
 * Phase 11 — getSmartReviewModel(provider, 'walkthrough') aliases to the
 * provider's triage tier by default (cheap-tier fast narration). Resolution
 * is explicit (not inferred from `triage`) so future per-provider tuning
 * is one-line.
 */

import { describe, expect, it } from 'vitest';
import providerService from '../providerService.js';

const { REVIEW_MODEL_DEFAULTS } = providerService;

describe('providerService.getSmartReviewModel("walkthrough")', () => {
  it('resolves to the triage-tier model for anthropic', () => {
    const triage = REVIEW_MODEL_DEFAULTS.anthropic.triage;
    const walkthrough = providerService.getSmartReviewModel('anthropic', 'walkthrough');
    expect(walkthrough).toBe(triage);
  });

  it('resolves to the triage-tier model for openai', () => {
    const triage = REVIEW_MODEL_DEFAULTS.openai.triage;
    const walkthrough = providerService.getSmartReviewModel('openai', 'walkthrough');
    expect(walkthrough).toBe(triage);
  });

  it('resolves to the triage-tier model for google', () => {
    const triage = REVIEW_MODEL_DEFAULTS.google.triage;
    const walkthrough = providerService.getSmartReviewModel('google', 'walkthrough');
    expect(walkthrough).toBe(triage);
  });

  it('resolves to the triage-tier model for opencode', () => {
    const triage = REVIEW_MODEL_DEFAULTS.opencode.triage;
    const walkthrough = providerService.getSmartReviewModel('opencode', 'walkthrough');
    expect(walkthrough).toBe(triage);
  });

  it('returns a different model for the "review" phase (proves walkthrough is decoupled)', () => {
    const walkthrough = providerService.getSmartReviewModel('anthropic', 'walkthrough');
    const review = providerService.getSmartReviewModel('anthropic', 'review');
    expect(walkthrough).not.toBe(review);
  });
});
