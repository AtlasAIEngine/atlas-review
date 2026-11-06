import type { AIProvider, ProviderType } from '@/types';
import { isProviderUsable } from './providerStatus';

export interface ProviderModelOptionLike {
  key: string;
  providerType: string;
  alias: string;
  isDefault: boolean;
}

export interface BuildContextActiveLike {
  providerId: string;
  model: string | null;
}

const BUILD_PROVIDER_PRIORITY: ProviderType[] = ['openai', 'anthropic', 'google', 'opencode'];

function getPriorityIndex(type: string): number {
  const index = BUILD_PROVIDER_PRIORITY.indexOf(type as ProviderType);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function resolveProviderTypeFromId(
  providerId: string | null | undefined,
  providers: AIProvider[] = [],
): string | null {
  if (!providerId) return null;

  const exact = providers.find((provider) => provider.id === providerId);
  if (exact?.type) return exact.type;

  const normalized = String(providerId).trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.startsWith('cli_')) return normalized.slice(4);
  if (normalized.startsWith('byok_')) return normalized.slice(5);
  if (normalized.startsWith('cli-')) return normalized.slice(4);
  if (normalized.startsWith('byok-')) return normalized.slice(5);
  if (normalized.endsWith('-byok')) return normalized.slice(0, -5);
  if (normalized.endsWith('_byok')) return normalized.slice(0, -5);

  const parts = normalized.split(/[_-]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : normalized;
}

export function getConnectedProvidersByPriority(providers: AIProvider[] = []): AIProvider[] {
  return providers
    .filter(isProviderUsable)
    .sort((left, right) => {
      const priorityDiff = getPriorityIndex(left.type) - getPriorityIndex(right.type);
      if (priorityDiff !== 0) return priorityDiff;
      return left.label.localeCompare(right.label);
    });
}

export function findPreferredModelKey(
  availableModels: ProviderModelOptionLike[],
  providerType: string | null | undefined,
  preferredModel: string | null | undefined = null,
): string | null {
  if (!providerType) return null;

  const models = availableModels.filter((model) => model.providerType === providerType);
  if (models.length === 0) return null;

  const normalizedPreferred = String(preferredModel || '').trim().toLowerCase();
  if (normalizedPreferred) {
    const exact = models.find((model) =>
      model.alias.toLowerCase() === normalizedPreferred
      || model.key.toLowerCase() === `${providerType}:${normalizedPreferred}`,
    );
    if (exact) return exact.key;
  }

  return models.find((model) => model.isDefault)?.key || models[0].key;
}

export function pickPreferredBuildModelKey(
  availableModels: ProviderModelOptionLike[],
  providers: AIProvider[] = [],
  options: {
    contextActive?: BuildContextActiveLike | null;
    storedCombined?: string | null;
    storedProvider?: string | null;
    authProvider?: string | null;
  } = {},
): string | null {
  if (availableModels.length === 0) return null;

  const hasModel = (key: string | null | undefined) =>
    Boolean(key) && availableModels.some((model) => model.key === key);

  const connectedProviders = getConnectedProvidersByPriority(providers);
  const connectedTypes = new Set(connectedProviders.map((provider) => provider.type));
  const isConnectedType = (providerType: string | null | undefined) =>
    Boolean(providerType) && connectedTypes.has(providerType as ProviderType);

  const contextType = resolveProviderTypeFromId(options.contextActive?.providerId, providers);
  if (isConnectedType(contextType)) {
    const contextKey = findPreferredModelKey(availableModels, contextType, options.contextActive?.model);
    if (hasModel(contextKey)) return contextKey;
  }

  const prioritizedProvider = connectedProviders[0] || null;
  if (prioritizedProvider) {
    const prioritizedKey = findPreferredModelKey(availableModels, prioritizedProvider.type, prioritizedProvider.model);
    if (hasModel(prioritizedKey)) return prioritizedKey;
  }

  if (hasModel(options.storedCombined)) {
    const storedModel = availableModels.find((model) => model.key === options.storedCombined);
    if (storedModel && (connectedTypes.size === 0 || isConnectedType(storedModel.providerType))) {
      return storedModel.key;
    }
  }

  if (isConnectedType(options.storedProvider)) {
    const storedProviderKey = findPreferredModelKey(availableModels, options.storedProvider);
    if (hasModel(storedProviderKey)) return storedProviderKey;
  }

  if (isConnectedType(options.authProvider)) {
    const authKey = findPreferredModelKey(availableModels, options.authProvider);
    if (hasModel(authKey)) return authKey;
  }

  return availableModels.find((model) => model.isDefault)?.key || availableModels[0]?.key || null;
}
