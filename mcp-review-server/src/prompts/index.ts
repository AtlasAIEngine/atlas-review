import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import type { PromptDefinition } from '../types.js';
import { createPrepareFixPlanFromFindingsPrompt } from './prepareFixPlanFromFindings.js';
import { createReviewCurrentBranchPrompt } from './reviewCurrentBranch.js';
import { createTriageHighRiskFindingsPrompt } from './triageHighRiskFindings.js';

export interface PromptDependencies {
  client: AtlasApiClient;
  config: AtlasConfig;
  cwd: string;
}

export function createPromptRegistry(deps: PromptDependencies): Map<string, PromptDefinition> {
  const prompts: PromptDefinition[] = [
    createReviewCurrentBranchPrompt(deps),
    createTriageHighRiskFindingsPrompt(deps),
    createPrepareFixPlanFromFindingsPrompt(deps),
  ];
  return new Map(prompts.map((prompt) => [prompt.name, prompt]));
}
