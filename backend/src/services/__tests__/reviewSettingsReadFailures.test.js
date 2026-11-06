import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = {
  query: vi.fn(),
};

vi.mock('../../db/connection.js', () => ({
  default: dbMock,
}));

describe('review settings read failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('keeps execution mode order behavior unchanged when the settings read succeeds', async () => {
    dbMock.query.mockResolvedValue({
      rows: [{ value: JSON.stringify(['cli-pipe', 'api']) }],
    });

    const reviewProviderExecution = await import('../review/reviewProviderExecution.js');
    reviewProviderExecution.invalidateExecutionModeOrderCache();

    await expect(reviewProviderExecution.getExecutionModeOrder()).resolves.toEqual(['cli-pipe', 'api']);
  });

  it('throws on execution mode order read failure and does not cache an empty fallback', async () => {
    let failRead = true;
    dbMock.query.mockImplementation(async () => {
      if (failRead) {
        throw new Error('execution mode db offline');
      }
      return { rows: [{ value: JSON.stringify(['cli-pipe']) }] };
    });

    const reviewProviderExecution = await import('../review/reviewProviderExecution.js');
    reviewProviderExecution.invalidateExecutionModeOrderCache();

    await expect(reviewProviderExecution.getExecutionModeOrder()).rejects.toMatchObject({
      name: 'SettingsReadError',
      settingKey: 'review_execution_mode_order',
      runtimeCode: 'settings_read_failed',
    });

    failRead = false;

    await expect(reviewProviderExecution.getExecutionModeOrder()).resolves.toEqual(['cli-pipe']);
    expect(dbMock.query).toHaveBeenCalledTimes(2);
  });

  it('keeps review model routing behavior unchanged when the settings read succeeds', async () => {
    dbMock.query.mockImplementation(async (_sql, [settingKey]) => {
      switch (settingKey) {
        case 'review_model_strategy':
          return { rows: [{ value: 'custom' }] };
        case 'review_model_custom':
          return { rows: [{ value: JSON.stringify({ review: 'claude-sonnet-4-6' }) }] };
        case 'review_model_adaptive':
          return { rows: [{ value: null }] };
        case 'review_model_rollout':
          return { rows: [{ value: null }] };
        default:
          return { rows: [] };
      }
    });

    const reviewModelConfigModule = await import('../review/reviewModelConfig.js');
    reviewModelConfigModule.reviewModelConfigCache.expiresAt = 0;

    await expect(reviewModelConfigModule.getGlobalReviewModelConfig()).resolves.toMatchObject({
      strategy: 'custom',
      customModels: {
        review: 'claude-sonnet-4-6',
      },
    });
  });

  it('throws on review model routing read failure and does not cache the default config', async () => {
    let failRead = true;
    dbMock.query.mockImplementation(async (_sql, [settingKey]) => {
      if (failRead) {
        throw new Error(`model config db offline for ${settingKey}`);
      }
      switch (settingKey) {
        case 'review_model_strategy':
          return { rows: [{ value: 'custom' }] };
        case 'review_model_custom':
          return { rows: [{ value: JSON.stringify({ review: 'gpt-5.4' }) }] };
        case 'review_model_adaptive':
        case 'review_model_rollout':
          return { rows: [{ value: null }] };
        default:
          return { rows: [] };
      }
    });

    const reviewModelConfigModule = await import('../review/reviewModelConfig.js');
    reviewModelConfigModule.reviewModelConfigCache.expiresAt = 0;

    await expect(reviewModelConfigModule.getGlobalReviewModelConfig()).rejects.toMatchObject({
      name: 'SettingsReadError',
      settingKey: 'review_model_config',
      runtimeCode: 'settings_read_failed',
    });

    failRead = false;
    reviewModelConfigModule.reviewModelConfigCache.expiresAt = 0;

    await expect(reviewModelConfigModule.getGlobalReviewModelConfig()).resolves.toMatchObject({
      strategy: 'custom',
      customModels: {
        review: 'gpt-5.4',
      },
    });
  });

  it('keeps review ignore pattern behavior unchanged when the settings read succeeds', async () => {
    dbMock.query.mockResolvedValue({
      rows: [{ value: JSON.stringify(['dist/**', 'coverage/**']) }],
    });

    const reviewIgnorePatternsModule = await import('../review/reviewIgnorePatterns.js');
    reviewIgnorePatternsModule.invalidateIgnorePatternCache();

    await expect(reviewIgnorePatternsModule.getGlobalReviewIgnorePatterns()).resolves.toEqual([
      'dist/**',
      'coverage/**',
    ]);
  });

  it('throws on review ignore pattern read failure and does not cache an empty list', async () => {
    let failRead = true;
    dbMock.query.mockImplementation(async () => {
      if (failRead) {
        throw new Error('ignore pattern db offline');
      }
      return {
        rows: [{ value: JSON.stringify(['dist/**']) }],
      };
    });

    const reviewIgnorePatternsModule = await import('../review/reviewIgnorePatterns.js');
    reviewIgnorePatternsModule.invalidateIgnorePatternCache();

    await expect(reviewIgnorePatternsModule.getGlobalReviewIgnorePatterns()).rejects.toMatchObject({
      name: 'SettingsReadError',
      settingKey: 'review_ignore_patterns',
      runtimeCode: 'settings_read_failed',
    });

    failRead = false;

    await expect(reviewIgnorePatternsModule.getGlobalReviewIgnorePatterns()).resolves.toEqual(['dist/**']);
    expect(dbMock.query).toHaveBeenCalledTimes(2);
  });

  it('normalizes settings read failures into actionable review errors and logs context', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [{ createSettingsReadError }, { default: reviewService }] = await Promise.all([
      import('../review/reviewErrors.js'),
      import('../reviewService.js'),
    ]);

    const wrapped = reviewService.__testing.normalizeReviewSettingsReadError(
      createSettingsReadError({
        settingKey: 'review_execution_mode_order',
        settingLabel: 'review execution mode order',
        operation: 'read review execution mode order',
        cause: new Error('db offline'),
      }),
      'Branch review'
    );

    expect(wrapped.runtimeCode).toBe('invalid_request');
    expect(wrapped.settingsReadFailure).toBe(true);
    expect(wrapped.message).toBe(
      'Branch review could not load review execution mode order. Check Review Settings or database connectivity and retry.'
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[ReviewService] Review settings read failed',
      expect.objectContaining({
        reviewSurface: 'Branch review',
        settingKey: 'review_execution_mode_order',
        settingLabel: 'review execution mode order',
      })
    );
  });
});
