import { test, expect } from '@playwright/test';

import {
  describeReviewSyncStatus,
  formatProviderBadgeLabel,
  formatProviderModelBadgeLabel,
  pickShellProvider,
} from '../trustPipelineShellUtils';
import type { ReviewSyncLocalStatus } from '@/services/api';
import type { AIProvider } from '@/types';

const codexProvider: AIProvider = {
  id: 'codex-cli',
  label: 'Codex CLI — via CLI',
  type: 'openai',
  model: 'gpt-5-codex',
  source: 'cli_detected',
  status: 'connected',
  isActive: false,
  lastCheckedAt: null,
};

const claudeProvider: AIProvider = {
  id: 'claude-cli',
  label: 'Claude Code (subscription) — via CLI',
  type: 'anthropic',
  model: 'claude-sonnet-4-5',
  source: 'cli_detected',
  status: 'connected',
  isActive: true,
  lastCheckedAt: null,
};

const baseSyncStatus: ReviewSyncLocalStatus = {
  enabled: true,
  configured: true,
  serverUrl: 'https://atlas.example.com',
  userId: 'user-1',
  deviceId: 'device-1',
  pendingEvents: 0,
  state: 'idle',
  lastSyncedAt: '2026-03-16T10:00:00.000Z',
  lastError: null,
  lastAttemptAt: null,
};

test.describe('trust pipeline shell provider badge', () => {
  test('formats provider labels for compact badge display', () => {
    expect(formatProviderBadgeLabel('Claude Code (subscription) — via CLI')).toBe('Claude Code (subscription)');
    expect(formatProviderBadgeLabel('Codex CLI (detected)')).toBe('Codex CLI');
  });

  test('formats the selected model for the top-bar badge', () => {
    expect(formatProviderModelBadgeLabel(
      { ...claudeProvider, label: 'Claude Code (claude.ai) — via CLI', model: 'claude-opus-4-7' },
      'claude-opus-4-7',
      [{ type: 'anthropic', models: [{ id: 'claude-opus-4-7', label: 'Claude Opus 4.7' }] }],
    )).toBe('Claude Opus 4.7 (claude.ai)');

    expect(formatProviderModelBadgeLabel(codexProvider, 'gpt-5.5', [
      { type: 'openai', models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }] },
    ])).toBe('GPT-5.5');

    expect(formatProviderModelBadgeLabel(codexProvider, 'gpt-5.5', [])).toBe('GPT-5.5');
    expect(formatProviderModelBadgeLabel(codexProvider, 'gpt-5.3-codex', [])).toBe('GPT-5.3-CODEX');
  });

  test('prefers the context-active provider over the global active provider', () => {
    const selected = pickShellProvider(
      [claudeProvider, codexProvider],
      'codex-cli',
      claudeProvider,
    );

    expect(selected?.id).toBe('codex-cli');
    expect(selected?.label).toContain('Codex');
  });

  test('falls back to the global active provider when the context provider is missing', () => {
    const selected = pickShellProvider(
      [claudeProvider, codexProvider],
      'missing-provider',
      claudeProvider,
    );

    expect(selected?.id).toBe('claude-cli');
  });

  test('returns null when no providers or fallback provider are available', () => {
    const selected = pickShellProvider([], null, null);

    expect(selected).toBeNull();
  });

  test('describes a healthy cloud sync badge when desktop sync is configured', () => {
    expect(describeReviewSyncStatus(baseSyncStatus)).toEqual({
      label: 'Cloud Sync',
      tone: 'success',
    });
  });

  test('describes pending cloud sync work explicitly', () => {
    expect(describeReviewSyncStatus({
      ...baseSyncStatus,
      pendingEvents: 3,
    })).toEqual({
      label: 'Pending 3',
      tone: 'warning',
    });
  });

  test('describes disabled operator sync when desktop mode is enabled but unconfigured', () => {
    expect(describeReviewSyncStatus({
      ...baseSyncStatus,
      configured: false,
      lastSyncedAt: null,
    })).toEqual({
      label: 'Cloud Sync Off',
      tone: 'neutral',
    });
  });
});
