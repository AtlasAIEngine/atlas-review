import { test, expect } from '@playwright/test';
import {
  buildWalkthroughChangeMap,
  buildWalkthroughReviewFocus,
  classifyWalkthroughFileRole,
  groupWalkthroughFilesByRole,
} from '../walkthroughChangeMap';
import type { ReviewChangeGroup, ReviewRecommendation } from '@/types';

function group(label: string, files: ReviewChangeGroup['files'], description = ''): ReviewChangeGroup {
  return {
    label,
    description,
    risk: 'low',
    files,
  };
}

test.describe('walkthroughChangeMap', () => {
  test('classifies common walkthrough file roles', () => {
    expect(classifyWalkthroughFileRole('src/api/IExperimentBackend.cs')).toBe('contract');
    expect(classifyWalkthroughFileRole('src/services/ExperimentService.cs')).toBe('implementation');
    expect(classifyWalkthroughFileRole('src/providers/ExperimentProvider.cs')).toBe('consumer');
    expect(classifyWalkthroughFileRole('src/__tests__/experiment.test.ts')).toBe('test');
    expect(classifyWalkthroughFileRole('docs/experiments.md')).toBe('docs');
    expect(classifyWalkthroughFileRole('Assets/Foo.prefab.meta')).toBe('generated');
    expect(classifyWalkthroughFileRole('package-lock.json')).toBe('generated');
  });

  test('groups files by role and collapses generated files by default', () => {
    const grouped = groupWalkthroughFilesByRole([
      { path: 'src/api/IExperimentBackend.cs', additions: 4, deletions: 0, description: '' },
      { path: 'src/services/ExperimentService.cs', additions: 10, deletions: 2, description: '' },
      { path: 'src/services/ExperimentService.cs.meta', additions: 1, deletions: 0, description: '' },
    ]);

    expect(grouped.map((entry) => entry.role)).toEqual(['contract', 'implementation', 'generated']);
    expect(grouped.find((entry) => entry.role === 'generated')?.collapsedByDefault).toBe(true);
  });

  test('builds dependency edges from contracts and implementations into consumers', () => {
    const groups: ReviewChangeGroup[] = [
      group('Experiment Backend Bridge', [
        { path: 'src/api/IExperimentBackend.cs', additions: 20, deletions: 0, description: 'Backend interface' },
      ]),
      group('Experiment Provider Integration', [
        { path: 'src/providers/ExperimentProvider.cs', additions: 30, deletions: 3, description: 'Wires provider to backend bridge' },
      ]),
    ];

    const map = buildWalkthroughChangeMap(groups);

    expect(map.edges).toEqual([
      expect.objectContaining({ from: 0, to: 1, kind: 'uses' }),
    ]);
    expect(map.readOrder).toEqual([0, 1]);
  });

  test('does not let metadata files dominate a mixed step role', () => {
    const map = buildWalkthroughChangeMap([
      group('Backend Bridge', [
        { path: 'src/api/IExperimentBackend.cs', additions: 20, deletions: 0, description: 'Backend interface' },
        { path: 'src/impl/ExperimentBackend.cs', additions: 30, deletions: 0, description: 'Backend implementation' },
        { path: 'src/api/IExperimentBackend.cs.meta', additions: 1, deletions: 0, description: '' },
        { path: 'src/impl/ExperimentBackend.cs.meta', additions: 1, deletions: 0, description: '' },
        { path: 'src/impl/Other.asset.meta', additions: 1, deletions: 0, description: '' },
      ]),
    ]);

    expect(map.nodes[0].primaryRole).toBe('contract');
  });

  test('keeps docs out of blocking read order while surfacing document edges', () => {
    const groups: ReviewChangeGroup[] = [
      group('Provider Integration', [
        { path: 'src/providers/ExperimentProvider.ts', additions: 10, deletions: 0, description: 'Experiment integration' },
      ]),
      group('Documentation', [
        { path: 'docs/provider-experiments.md', additions: 20, deletions: 0, description: 'Experiment usage notes' },
      ]),
    ];

    const map = buildWalkthroughChangeMap(groups);

    expect(map.edges).toEqual([
      expect.objectContaining({ from: 1, to: 0, kind: 'documents' }),
    ]);
    expect(map.readOrder).toEqual([0, 1]);
  });

  test('orders docs last even when documentation is first in the generated walkthrough', () => {
    const groups: ReviewChangeGroup[] = [
      group('PostHog Experiment Documentation', [
        { path: 'docs/posthog.md', additions: 100, deletions: 0, description: '' },
      ]),
      group('Analytics PostHog Experiment Backend', [
        { path: 'src/api/IPostHogExperimentBackend.cs', additions: 20, deletions: 0, description: 'Backend interface' },
      ]),
      group('PostHog Experiment Provider', [
        { path: 'src/impl/PostHogExperimentProvider.cs', additions: 30, deletions: 3, description: 'Provider implementation' },
      ]),
    ];

    const map = buildWalkthroughChangeMap(groups);

    expect(map.readOrder).toEqual([1, 2, 0]);
  });

  test('pins deterministic asset and deleted groups after authored walkthrough steps', () => {
    const groups: ReviewChangeGroup[] = [
      group('Experiment Service Provider Abstraction', [
        { path: 'src/api/IExperimentBackend.cs', additions: 20, deletions: 2, description: 'Backend interface' },
      ]),
      group('Assets and generated files', [
        { path: 'Assets/Foo.prefab.meta', additions: 8, deletions: 0, description: '' },
      ]),
      group('Deleted files', [
        { path: 'src/legacy/OldExperimentService.cs', additions: 0, deletions: 100, description: '' },
      ]),
      group('Documentation & Architecture Guidance', [
        { path: 'docs/posthog.md', additions: 100, deletions: 0, description: '' },
      ]),
      group('Platform-Specific Native Integration', [
        { path: 'src/impl/NativePostHogBridge.cs', additions: 30, deletions: 3, description: 'Native implementation' },
      ]),
    ];

    const map = buildWalkthroughChangeMap(groups);
    const labels = map.readOrder.map((index) => groups[index].label);

    expect(labels.slice(-2)).toEqual(['Assets and generated files', 'Deleted files']);
    expect(labels.indexOf('Documentation & Architecture Guidance')).toBeLessThan(labels.indexOf('Assets and generated files'));
  });

  test('uses layer order before cross-layer topology edges', () => {
    const groups: ReviewChangeGroup[] = [
      group('Analytics PostHog Experiment Backend', [
        { path: 'src/api/IPostHogExperimentBackend.cs', additions: 20, deletions: 0, description: 'Backend interface' },
      ]),
      group('App And Login Glue', [
        { path: 'src/api/LoginGlue.cs', additions: 10, deletions: 0, description: 'App lifecycle glue' },
      ]),
      group('Native Platform Bridges', [
        { path: 'src/impl/NativePostHogBridge.cs', additions: 30, deletions: 3, description: 'Native implementation' },
      ]),
      group('PostHog Experiment Documentation', [
        { path: 'docs/posthog.md', additions: 100, deletions: 0, description: '' },
      ]),
    ];

    const map = buildWalkthroughChangeMap(groups);

    expect(map.readOrder).toEqual([0, 2, 1, 3]);
  });

  test('uses findings and risk when ordering independent steps', () => {
    const groups: ReviewChangeGroup[] = [
      group('Routine docs', [
        { path: 'docs/readme.md', additions: 3, deletions: 0, description: '' },
      ]),
      {
        ...group('Feature Flag Fetching', [
          { path: 'src/services/FeatureFlagService.ts', additions: 30, deletions: 3, description: '' },
        ]),
        risk: 'high',
      },
    ];
    const findings: ReviewRecommendation[] = [
      {
        type: 'issue',
        severity: 'high',
        title: 'Cache not reset',
        description: 'Feature flags may be stale.',
        file: 'src/services/FeatureFlagService.ts',
      },
    ];

    const map = buildWalkthroughChangeMap(groups, findings);

    expect(map.nodes[1].findingCount).toBe(1);
    expect(map.readOrder[0]).toBe(1);
  });

  test('derives concise review focus bullets', () => {
    const focus = buildWalkthroughReviewFocus(
      group('Backend Bridge', [
        { path: 'src/api/IExperimentBackend.cs', additions: 20, deletions: 0, description: 'Async identity reset API' },
        { path: 'src/services/ExperimentBackend.cs', additions: 30, deletions: 0, description: 'Calls provider with cancellation token' },
      ]),
      [{
        type: 'issue',
        severity: 'medium',
        title: 'Cancellation ignored',
        description: 'Cancellation token is not honored.',
        file: 'src/services/ExperimentBackend.cs',
      }],
    );

    expect(focus).toContain('1 open finding in this step');
    expect(focus).toContain('Public contract or API shape changed');
    expect(focus).toContain('Check lifecycle, identity, cancellation, and external-call behavior');
    expect(focus).toContain('No test files are grouped with this change');
  });
});
