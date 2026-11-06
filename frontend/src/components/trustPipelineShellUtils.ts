import type { AIProvider } from '@/types';
import type { ReviewSyncLocalStatus } from '@/services/api';
import { isProviderUsable } from '@/utils/providerStatus';

export interface ProviderModelConfig {
  type: string;
  models: Array<{ id: string; label: string }>;
}

export function formatProviderBadgeLabel(label: string | null): string | null {
  return label
    ? label.replace(/ — via CLI$/, '').replace(/ \(detected\)/, '')
    : null;
}

function extractProviderBadgeQualifier(label: string | null | undefined): string | null {
  const compact = formatProviderBadgeLabel(label || null);
  const match = compact?.match(/\(([^)]+)\)/);
  const qualifier = match?.[1]?.trim();
  if (!qualifier || qualifier.toLowerCase() === 'detected') return null;
  return qualifier;
}

function titleCaseModelPart(part: string): string {
  const lower = part.toLowerCase();
  if (lower === 'gpt') return 'GPT';
  if (lower === 'cli') return 'CLI';
  if (lower === 'api') return 'API';
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function fallbackModelLabel(model: string): string {
  const normalized = String(model || '').trim();
  if (!normalized) return 'Unknown model';
  const parts = normalized.split('/').filter(Boolean);
  const withoutProvider = parts.length > 0 ? parts[parts.length - 1] : normalized;
  const cleaned = withoutProvider.replace(/-preview$/i, '');
  if (/^gpt-\d+(?:\.\d+)?(?:-[a-z0-9]+)?$/i.test(cleaned)) {
    return cleaned.toUpperCase();
  }
  return cleaned
    .split('-')
    .filter(Boolean)
    .map(titleCaseModelPart)
    .join(' ');
}

export function formatProviderModelBadgeLabel(
  provider: AIProvider | null,
  model: string | null | undefined,
  configs: ProviderModelConfig[] = [],
): string | null {
  if (!provider) return null;
  const normalizedModel = String(model || provider.model || '').trim();
  const modelConfig = configs
    .find((config) => config.type === provider.type)
    ?.models
    ?.find((candidate) => candidate.id === normalizedModel);
  const modelLabel = modelConfig?.label || fallbackModelLabel(normalizedModel);
  const qualifier = extractProviderBadgeQualifier(provider.label);
  return qualifier ? `${modelLabel} (${qualifier})` : modelLabel;
}

export function pickShellProvider(
  providers: AIProvider[],
  contextProviderId: string | null,
  fallbackActiveProvider: AIProvider | null,
): AIProvider | null {
  if (!Array.isArray(providers) || providers.length === 0) {
    return fallbackActiveProvider;
  }

  if (contextProviderId) {
    const contextProvider = providers.find((provider) => provider.id === contextProviderId);
    if (contextProvider) {
      return contextProvider;
    }
  }

  if (fallbackActiveProvider) {
    return fallbackActiveProvider;
  }

  return providers.find(isProviderUsable) || providers[0] || null;
}

export interface ReviewSyncBadgeDescriptor {
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}

export function describeReviewSyncStatus(
  status: ReviewSyncLocalStatus | null,
): ReviewSyncBadgeDescriptor | null {
  if (!status?.enabled) {
    return null;
  }

  if (!status.configured) {
    return {
      label: 'Cloud Sync Off',
      tone: 'neutral',
    };
  }

  if (status.state === 'syncing') {
    return {
      label: status.pendingEvents > 0 ? `Syncing ${status.pendingEvents}` : 'Syncing',
      tone: 'info',
    };
  }

  if (status.state === 'error') {
    return {
      label: status.pendingEvents > 0 ? `Sync Error ${status.pendingEvents}` : 'Sync Error',
      tone: 'danger',
    };
  }

  if (status.pendingEvents > 0) {
    return {
      label: `Pending ${status.pendingEvents}`,
      tone: 'warning',
    };
  }

  return {
    label: 'Cloud Sync',
    tone: status.lastSyncedAt ? 'success' : 'neutral',
  };
}
