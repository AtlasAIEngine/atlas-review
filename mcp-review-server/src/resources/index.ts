import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import type { ResourceDefinition } from '../types.js';
import { createReviewCurrentFindingsResource } from './reviewCurrentFindings.js';
import { createReviewCurrentResource } from './reviewCurrent.js';
import { createReviewCurrentStatusResource } from './reviewCurrentStatus.js';

export interface ResourceDependencies {
  client: AtlasApiClient;
  config: AtlasConfig;
  cwd: string;
}

export function createResourceRegistry(deps: ResourceDependencies): Map<string, ResourceDefinition> {
  const resources: ResourceDefinition[] = [
    createReviewCurrentResource(deps),
    createReviewCurrentFindingsResource(deps),
    createReviewCurrentStatusResource(deps),
  ];
  return new Map(resources.map((resource) => [resource.uri, resource]));
}
