import { afterEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const getDbTypeMock = vi.fn();

vi.mock('../connection.js', () => ({
  query: queryMock,
  transaction: vi.fn(),
  getDbType: getDbTypeMock,
}));

const { createProject } = await import('../queries.js');

afterEach(() => {
  queryMock.mockReset();
  getDbTypeMock.mockReset();
});

describe('createProject', () => {
  it('writes the source column for fresh-install projects tables', async () => {
    getDbTypeMock.mockReturnValue('sqlite');
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { name: 'id' },
          { name: 'user_id' },
          { name: 'session_id' },
          { name: 'name' },
          { name: 'description' },
          { name: 'path' },
          { name: 'framework' },
          { name: 'language' },
          { name: 'source' },
          { name: 'created_at' },
        ],
        rowCount: 10,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: 'project-id',
          name: 'AtlasEngineMVP',
          path: '/tmp/project',
          source: 'local',
        }],
        rowCount: 1,
      });

    const project = await createProject({
      userId: 'user-id',
      sessionId: 'session-id',
      name: 'AtlasEngineMVP',
      description: 'Imported',
      path: '/tmp/project',
      framework: null,
      language: null,
      source: 'local',
      generatedReviewPolicyJson: '{"version":1}',
      generatedReviewPolicyHash: 'policy-hash',
      generatedReviewPolicyVersion: 1,
      generatedReviewPolicyGeneratorVersion: 'stack_aware_v1',
      generatedReviewPolicyGeneratedAt: '2026-04-01T00:00:00.000Z',
    });

    expect(project.id).toBe('project-id');
    expect(project.source).toBe('local');
    expect(queryMock).toHaveBeenCalledTimes(7);
    expect(queryMock.mock.calls[0][0]).toContain('PRAGMA table_info(projects)');
    expect(queryMock.mock.calls[6][0]).toContain('generated_review_policy_json');
  });

  it('tolerates duplicate generated review policy columns in sqlite bootstrap', async () => {
    vi.resetModules();
    const { createProject: freshCreateProject } = await import('../queries.js');
    getDbTypeMock.mockReturnValue('sqlite');
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error('duplicate column name: generated_review_policy_json'))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{
          id: 'project-id',
          name: 'ExampleProject',
          path: '/tmp/project-black',
          source: 'local',
        }],
        rowCount: 1,
      });

    const project = await freshCreateProject({
      userId: 'user-id',
      sessionId: 'session-id',
      name: 'ExampleProject',
      description: 'Imported',
      path: '/tmp/project-black',
      framework: null,
      language: null,
      source: 'local',
      generatedReviewPolicyJson: '{"version":1}',
      generatedReviewPolicyHash: 'policy-hash',
      generatedReviewPolicyVersion: 1,
      generatedReviewPolicyGeneratorVersion: 'stack_aware_v1',
      generatedReviewPolicyGeneratedAt: '2026-04-01T00:00:00.000Z',
    });

    expect(project.id).toBe('project-id');
    expect(project.source).toBe('local');
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('ALTER TABLE projects ADD COLUMN generated_review_policy_hash'))).toBe(true);
  });
});
