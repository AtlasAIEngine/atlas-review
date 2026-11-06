/**
 * walkthroughService unit tests
 *
 * Phase 11 — decouple walkthrough generation from review.
 *
 * Coverage:
 * - Hit path: known (projectId, baseSha, headSha) returns parsed change groups.
 * - Miss path: unknown key returns null.
 * - Legacy fallback: getWalkthroughForReview returns reviewJson.changeGroups
 *   without writing back to the new table.
 * - Round-trip: saveWalkthrough -> getWalkthrough preserves shape.
 * - SQLite TEXT deserialization: stored JSON string is parsed on read
 *   (dual-DB guard from CLAUDE.md).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
let dbType = 'postgres';

vi.mock('../../db/connection.js', () => ({
  query: (...args) => queryMock(...args),
  getDbType: () => dbType,
}));

let walkthroughService;

beforeEach(async () => {
  vi.clearAllMocks();
  dbType = 'postgres';
  // Re-import to pick up clean mocks (vitest evaluates modules once otherwise).
  walkthroughService = (await import('../walkthroughService.js')).default;
});

describe('walkthroughService.getWalkthrough', () => {
  it('returns parsed change groups when a row exists (postgres / JSONB)', async () => {
    const groups = [
      { label: 'Auth refactor', description: 'Tightens login flow', risk: 'low', files: [{ path: 'src/auth.js', additions: 12, deletions: 4 }] },
    ];
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          base_sha: 'base',
          head_sha: 'head',
          change_groups: groups, // JSONB returns parsed object directly
          model_id: 'claude-haiku-4-5-20251001',
          provider_type: 'anthropic',
          run_metadata: { durationMs: 123, totalTokens: 10 },
          created_at: '2026-04-26T00:00:00.000Z',
          updated_at: '2026-04-26T00:00:00.000Z',
        },
      ],
    });

    const result = await walkthroughService.getWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
    });

    expect(result).not.toBeNull();
    expect(result.changeGroups).toEqual(groups);
    expect(result.modelId).toBe('claude-haiku-4-5-20251001');
    expect(result.providerType).toBe('anthropic');
    expect(result.runMetadata).toEqual({ durationMs: 123, totalTokens: 10 });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('FROM walkthroughs');
    expect(sql).toContain('project_id = $1');
    expect(sql).toContain('base_sha = $2');
    expect(sql).toContain('head_sha = $3');
    expect(params).toEqual(['proj-1', 'base', 'head']);
  });

  it('parses change_groups from a JSON string when the driver returns TEXT (sqlite)', async () => {
    dbType = 'sqlite';
    walkthroughService = (await import('../walkthroughService.js')).default;
    const groups = [
      { label: 'Bugfix', description: 'Null check', risk: 'medium', files: [{ path: 'a.ts', additions: 2, deletions: 1 }] },
    ];
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          base_sha: 'base',
          head_sha: 'head',
          change_groups: JSON.stringify(groups), // SQLite TEXT returns string
          model_id: 'gpt-5.4-mini',
          provider_type: 'openai',
        },
      ],
    });

    const result = await walkthroughService.getWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
    });

    expect(result.changeGroups).toEqual(groups);
  });

  it('returns null when no row matches', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await walkthroughService.getWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
    });

    expect(result).toBeNull();
  });

  it('returns null when projectId / baseSha / headSha are missing', async () => {
    expect(await walkthroughService.getWalkthrough({ projectId: '', baseSha: 'x', headSha: 'y' })).toBeNull();
    expect(await walkthroughService.getWalkthrough({ projectId: 'x', baseSha: '', headSha: 'y' })).toBeNull();
    expect(await walkthroughService.getWalkthrough({ projectId: 'x', baseSha: 'y', headSha: '' })).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('walkthroughService.saveWalkthrough', () => {
  it('upserts on the unique (project_id, base_sha, head_sha) index', async () => {
    const groups = [{ label: 'X', description: 'Y', risk: 'low', files: [] }];
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          base_sha: 'base',
          head_sha: 'head',
          change_groups: groups,
          model_id: 'claude-haiku-4-5-20251001',
          provider_type: 'anthropic',
        },
      ],
    });

    await walkthroughService.saveWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      changeGroups: groups,
      modelId: 'claude-haiku-4-5-20251001',
      providerType: 'anthropic',
      runMetadata: { durationMs: 123 },
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO walkthroughs/);
    expect(sql).toMatch(/ON CONFLICT \(project_id, base_sha, head_sha\) DO UPDATE/);
    // change_groups is the 4th value param
    expect(params[0]).toBe('proj-1');
    expect(params[1]).toBe('base');
    expect(params[2]).toBe('head');
    expect(params.at(-1)).toBe(JSON.stringify({ durationMs: 123 }));
  });

  it('serializes change_groups as JSON string for sqlite', async () => {
    dbType = 'sqlite';
    walkthroughService = (await import('../walkthroughService.js')).default;
    const groups = [{ label: 'X', description: 'Y', risk: 'low', files: [] }];
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          base_sha: 'base',
          head_sha: 'head',
          change_groups: JSON.stringify(groups),
          model_id: null,
          provider_type: null,
        },
      ],
    });

    await walkthroughService.saveWalkthrough({
      projectId: 'proj-1',
      baseSha: 'base',
      headSha: 'head',
      changeGroups: groups,
    });

    const [, params] = queryMock.mock.calls[0];
    // SQLite path includes an explicit `id` first param, so:
    //   [id, projectId, baseSha, headSha, change_groups, modelId, providerType]
    // JSON-serialized as a string for SQLite TEXT.
    expect(typeof params[4]).toBe('string');
    expect(JSON.parse(params[4])).toEqual(groups);
  });

  it('round-trips changeGroups through save -> get without shape loss', async () => {
    const groups = [
      { label: 'Refactor', description: 'desc', risk: 'low', files: [{ path: 'x.js', additions: 1, deletions: 0 }] },
    ];
    // First call: save
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'wt-1', project_id: 'proj-1', base_sha: 'b', head_sha: 'h',
        change_groups: groups, model_id: null, provider_type: null,
      }],
    });
    // Second call: get
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'wt-1', project_id: 'proj-1', base_sha: 'b', head_sha: 'h',
        change_groups: groups, model_id: null, provider_type: null,
      }],
    });

    await walkthroughService.saveWalkthrough({
      projectId: 'proj-1', baseSha: 'b', headSha: 'h', changeGroups: groups,
    });
    const got = await walkthroughService.getWalkthrough({
      projectId: 'proj-1', baseSha: 'b', headSha: 'h',
    });

    expect(got.changeGroups).toEqual(groups);
  });

  it('throws if changeGroups is not an array', async () => {
    await expect(walkthroughService.saveWalkthrough({
      projectId: 'p', baseSha: 'b', headSha: 'h', changeGroups: 'oops',
    })).rejects.toThrow();
  });
});

describe('walkthroughService.getWalkthroughForReview', () => {
  it('returns the new-table walkthrough when present', async () => {
    const groups = [{ label: 'New', description: 'd', risk: 'low', files: [] }];
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: 'wt-1', project_id: 'p', base_sha: 'b', head_sha: 'h',
        change_groups: groups, model_id: null, provider_type: null,
      }],
    });

    const result = await walkthroughService.getWalkthroughForReview({
      projectId: 'p', baseSha: 'b', headSha: 'h',
      reviewJson: { changeGroups: [{ label: 'Legacy', files: [] }] },
    });

    expect(result).toEqual(groups);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to reviewJson.changeGroups on miss without writing back', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const legacy = [{ label: 'Legacy', description: 'old', risk: 'low', files: [] }];

    const result = await walkthroughService.getWalkthroughForReview({
      projectId: 'p', baseSha: 'b', headSha: 'h',
      reviewJson: { changeGroups: legacy },
    });

    expect(result).toEqual(legacy);
    // exactly one query (the lookup); no INSERT was issued
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/SELECT/i);
    expect(sql).not.toMatch(/INSERT/i);
  });

  it('returns null when both new table miss and legacy reviewJson lacks changeGroups', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await walkthroughService.getWalkthroughForReview({
      projectId: 'p', baseSha: 'b', headSha: 'h',
      reviewJson: null,
    });

    expect(result).toBeNull();
  });

  it('handles malformed legacy reviewJson.changeGroups (non-array) by returning null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await walkthroughService.getWalkthroughForReview({
      projectId: 'p', baseSha: 'b', headSha: 'h',
      reviewJson: { changeGroups: 'not an array' },
    });

    expect(result).toBeNull();
  });
});
