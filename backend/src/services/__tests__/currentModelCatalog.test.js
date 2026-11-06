import { afterEach, expect, it, vi } from 'vitest';
import providerService from '../providerService.js';
import codexAdapter from '../cliAdapters/CodexAdapter.js';
import claudeAdapter from '../cliAdapters/ClaudeAdapter.js';
import usageService from '../usageService.js';
import { callOpenAI } from '../review/reviewProviderExecution.js';

afterEach(() => vi.unstubAllGlobals());

it.each(['gpt-6.1-sol','gpt-6-astra','gpt-6.1-terra','gpt-6-luna','gpt-6-sol'])('passes %s unchanged to Codex and exposes it for review', model => {
  const config=providerService.getProviderConfigs().find(config=>config.type==='openai');
  expect(config.models.some(item=>item.id===model && item.reviewCapable!==false)).toBe(true);
  expect(codexAdapter.getModels().some(item=>item.alias===model)).toBe(true);
  const {args}=codexAdapter.buildArgs({message:'Review this branch',model});
  expect(args[args.indexOf('--model')+1]).toBe(model);
});

it.each([['claude-opus-5-5','opus'],['claude-sonnet-5-5','sonnet'],['claude-haiku-5-5','haiku'],['claude-fable-5-1','claude-fable-5-1'],['claude-opus-4-7','claude-opus-4-7']])('routes %s through its intended Claude model argument', (model,expected) => {
  const config=providerService.getProviderConfigs().find(config=>config.type==='anthropic');
  expect(config.models.some(item=>item.id===model)).toBe(true);
  const {args}=claudeAdapter.buildArgs({message:'Review this branch',model});
  expect(args[args.indexOf('--model')+1]).toBe(expected);
});

it('uses reasoning-model token limits for GPT-6 API review without sending tools', async () => {
  const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({choices:[{message:{content:'{}'}}],usage:{}})});
  vi.stubGlobal('fetch',fetch);
  await callOpenAI('Review this patch','fixture-key','gpt-6.1-sol');
  const body=JSON.parse(fetch.mock.calls[0][1].body);
  expect(body.model).toBe('gpt-6.1-sol');
  expect(body.max_completion_tokens).toBe(16384);
  expect(body.max_tokens).toBeUndefined();
  expect(body.tools).toBeUndefined();
});

it('applies GPT-6 and Haiku long-context pricing at the documented boundaries', () => {
  const sol=usageService.calculateCost('openai','gpt-6.1-sol',272000,1000);
  const solLong=usageService.calculateCost('openai','gpt-6.1-sol',272001,1000);
  expect(sol).toBeCloseTo(0.554,6);
  expect(solLong).toBeCloseTo(1.103004,6);
  expect(usageService.calculateCost('anthropic','claude-haiku-5-5',100000,1000)).toBeCloseTo(0.0105,6);
  expect(usageService.calculateCost('anthropic','claude-haiku-5-5',100001,1000)).toBeCloseTo(0.0525,5);
});
