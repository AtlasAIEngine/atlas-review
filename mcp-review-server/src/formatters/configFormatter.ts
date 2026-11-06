import type { ConfigGetToolData, ConfigSetStrategyToolData } from '../types.js';

export function formatConfigGetSummary(data: ConfigGetToolData): string {
  const lines: string[] = [];
  const strategySourceLabel = data.strategySource === 'persisted' ? 'persisted setting' : 'default fallback';

  lines.push(`Project: ${data.project.name} (${data.project.id})`);
  lines.push(`Review strategy: ${data.reviewStrategy} (${strategySourceLabel})`);

  if (!data.activeReviewProvider.providerId) {
    lines.push('Active review provider: none configured');
    lines.push(`Available providers: ${data.providers.length}`);
    return lines.join('\n');
  }

  const providerLabel = data.activeReviewProvider.provider?.label || data.activeReviewProvider.providerId;
  const providerStatus = data.activeReviewProvider.provider?.status || 'unknown';

  lines.push(`Active review provider: ${providerLabel} (${data.activeReviewProvider.providerId})`);
  lines.push(`Active review model: ${data.activeReviewProvider.model || 'not set'}`);
  lines.push(`Provider status: ${providerStatus}`);

  return lines.join('\n');
}

export function formatConfigSetStrategySummary(data: ConfigSetStrategyToolData): string {
  const lines: string[] = [];

  lines.push(`Project: ${data.project.name} (${data.project.id})`);
  lines.push(`Review strategy updated: ${data.reviewStrategy}`);
  if (data.previousReviewStrategy && data.previousReviewStrategy !== data.reviewStrategy) {
    lines.push(`Previous strategy: ${data.previousReviewStrategy}`);
  }

  return lines.join('\n');
}
