import { describe, expect, it, vi } from 'vitest';

const { runLinterPrePassMock } = vi.hoisted(() => ({
  runLinterPrePassMock: vi.fn(),
}));

const { runUnitySemanticVerifierMock } = vi.hoisted(() => ({
  runUnitySemanticVerifierMock: vi.fn(),
}));

vi.mock('../linter/linterRunner.js', () => ({
  runLinterPrePass: runLinterPrePassMock,
}));

vi.mock('../unitySemanticVerifier.js', () => ({
  runUnitySemanticVerifier: runUnitySemanticVerifierMock,
}));

describe('runReviewLinterPrePass', () => {
  it('passes the resolved review profile through to the linter runner', async () => {
    process.env.ATLAS_REVIEW_LINTER_ENABLED = 'true';
    runLinterPrePassMock.mockResolvedValue({
      findings: [],
      anchoredFindings: [],
      promptFindings: [],
      stats: { enabled: true },
    });
    runUnitySemanticVerifierMock.mockResolvedValue({
      findings: [],
      anchoredFindings: [],
      promptFindings: [],
      stats: { enabled: false },
    });

    const { runReviewLinterPrePass } = await import('../linter/linterReviewIntegration.js');
    const reviewProfile = {
      stackFamily: 'unity',
      projectContext: { unityRoot: 'Project_BLACK/BLACK_Unity' },
    };

    await runReviewLinterPrePass(
      '/repo',
      [{ path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Player.cs' }],
      '',
      { reviewProfile }
    );

    expect(runLinterPrePassMock).toHaveBeenCalledWith(
      '/repo',
      ['Project_BLACK/BLACK_Unity/Assets/Scripts/Player.cs'],
      '',
      expect.objectContaining({
        reviewProfile,
      })
    );

    expect(runUnitySemanticVerifierMock).toHaveBeenCalledWith(
      '/repo',
      [{ path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Player.cs' }],
      '',
      expect.objectContaining({
        reviewProfile,
      })
    );

    delete process.env.ATLAS_REVIEW_LINTER_ENABLED;
  });

  it('preserves findingsByRule when one pre-pass returns an empty result', async () => {
    process.env.ATLAS_REVIEW_LINTER_ENABLED = 'true';
    runLinterPrePassMock.mockResolvedValue({
      findings: [],
      anchoredFindings: [],
      promptFindings: [],
      stats: {
        enabled: true,
        findingsByRule: {},
      },
    });
    runUnitySemanticVerifierMock.mockResolvedValue({
      findings: [{ ruleId: 'unity.editor_api_in_runtime_path' }],
      anchoredFindings: [{ ruleId: 'unity.editor_api_in_runtime_path' }],
      promptFindings: [],
      stats: {
        enabled: true,
        findingsByRule: {
          'unity.editor_api_in_runtime_path': 1,
        },
      },
    });

    const { runReviewLinterPrePass } = await import('../linter/linterReviewIntegration.js');
    const result = await runReviewLinterPrePass(
      '/repo',
      [{ path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Player.cs' }],
      '',
      { reviewProfile: { stackFamily: 'unity' } }
    );

    expect(result.stats.findingsByRule).toEqual({
      'unity.editor_api_in_runtime_path': 1,
    });

    delete process.env.ATLAS_REVIEW_LINTER_ENABLED;
  });
});
