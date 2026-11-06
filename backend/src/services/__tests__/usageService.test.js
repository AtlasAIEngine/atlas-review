import { describe, expect, it } from 'vitest';
import usageService from '../usageService.js';

describe('usageService.buildCostSnapshot', () => {
  it('uses exact configured pricing for current supported models', () => {
    const snapshot = usageService.buildCostSnapshot({
      providerType: 'openai',
      model: 'gpt-5.4',
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(snapshot.estimatedCost).toBe(0.01);
    expect(snapshot.costSource).toBe('pricing_table');
    expect(snapshot.costIsApproximate).toBe(false);
    expect(snapshot.pricingKey).toBe('openai/gpt-5.4');
  });

  it('uses exact configured pricing for GPT-5.5 models', () => {
    const snapshot = usageService.buildCostSnapshot({
      providerType: 'openai',
      model: 'gpt-5.5',
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(snapshot.estimatedCost).toBe(0.02);
    expect(snapshot.costSource).toBe('pricing_table');
    expect(snapshot.costIsApproximate).toBe(false);
    expect(snapshot.pricingKey).toBe('openai/gpt-5.5');
  });

  it('does not price GPT-5.4 mini models as full GPT-5.4', () => {
    const snapshot = usageService.buildCostSnapshot({
      providerType: 'openai',
      model: 'gpt-5.4-mini',
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(snapshot.estimatedCost).toBe(0.003);
    expect(snapshot.costSource).toBe('pricing_table');
    expect(snapshot.costIsApproximate).toBe(false);
    expect(snapshot.pricingKey).toBe('openai/gpt-5.4-mini');
  });

  it('uses exact configured pricing for GPT-5.4 nano models', () => {
    const snapshot = usageService.buildCostSnapshot({
      providerType: 'openai',
      model: 'gpt-5.4-nano',
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(snapshot.estimatedCost).toBe(0.000825);
    expect(snapshot.costSource).toBe('pricing_table');
    expect(snapshot.costIsApproximate).toBe(false);
    expect(snapshot.pricingKey).toBe('openai/gpt-5.4-nano');
  });

  it('uses higher Gemini Pro rates when prompt tokens cross the vendor pricing tier', () => {
    const snapshot = usageService.buildCostSnapshot({
      providerType: 'google',
      model: 'gemini-3.1-pro-preview',
      inputTokens: 200001,
      outputTokens: 1000,
    });

    expect(snapshot.estimatedCost).toBe(0.818004);
    expect(snapshot.costSource).toBe('pricing_table');
    expect(snapshot.costIsApproximate).toBe(false);
    expect(snapshot.pricingKey).toBe('google/gemini-3.1-pro-preview');
  });

  it('uses provider native cost when a review path reports one', () => {
    const snapshot = usageService.buildCostSnapshot({
      providerType: 'openai',
      model: 'gpt-5.3-codex',
      inputTokens: 0,
      outputTokens: 0,
      providerNativeCost: 0.123456,
    });

    expect(snapshot.estimatedCost).toBe(0.123456);
    expect(snapshot.providerNativeCost).toBe(0.123456);
    expect(snapshot.costSource).toBe('provider_native');
    expect(snapshot.costIsApproximate).toBe(false);
    expect(snapshot.pricingKey).toBeNull();
  });

  it('falls back to pricing-table estimation when provider-native cost is zero but tokens are present', () => {
    const snapshot = usageService.buildCostSnapshot({
      providerType: 'openai',
      model: 'gpt-5.3-codex',
      inputTokens: 3151694,
      outputTokens: 8950,
      providerNativeCost: 0,
    });

    expect(snapshot.providerNativeCost).toBeNull();
    expect(snapshot.costSource).toBe('pricing_table');
    expect(snapshot.costIsApproximate).toBe(false);
    expect(snapshot.estimatedCost).toBeGreaterThan(0);
  });

  it('treats embedded provider/model values as billable identity for opencode-backed reviews', () => {
    const snapshot = usageService.buildCostSnapshot({
      providerType: 'opencode',
      model: 'google/gemini-2.5-flash',
      inputTokens: 1000,
      outputTokens: 1000,
    });

    expect(snapshot.providerType).toBe('google');
    expect(snapshot.model).toBe('gemini-2.5-flash');
    expect(snapshot.costSource).toBe('pricing_table');
    expect(snapshot.costIsApproximate).toBe(false);
    expect(snapshot.estimatedCost).toBe(0.0028);
  });

  it('marks unknown model families as approximate fallback estimates', () => {
    const snapshot = usageService.buildCostSnapshot({
      providerType: 'openai',
      model: 'mystery-model',
      inputTokens: 10,
      outputTokens: 20,
    });

    expect(snapshot.costSource).toBe('fallback_pricing');
    expect(snapshot.costIsApproximate).toBe(true);
    expect(snapshot.estimatedCost).toBeGreaterThan(0);
  });
});
