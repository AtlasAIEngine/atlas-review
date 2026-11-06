/**
 * Walkthrough file cache service tests.
 *
 * Verifies content-hash key derivation, bulk get/put behaviour against a
 * mocked DB driver, and the prompt-version invalidation contract.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('../../db/connection.js', () => ({
  query: (...args) => queryMock(...args),
  getDbType: () => 'postgres',
}));

import {
  computeFileCacheKey,
  getMany,
  putMany,
  WALKTHROUGH_PROMPT_VERSION,
} from '../walkthroughFileCacheService.js';

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
});

describe('computeFileCacheKey', () => {
  it('produces identical hashes for identical diff text', () => {
    const a = computeFileCacheKey({ diffText: '+foo\n-bar' });
    const b = computeFileCacheKey({ diffText: '+foo\n-bar' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different hashes when the diff text differs', () => {
    const a = computeFileCacheKey({ diffText: '+foo' });
    const b = computeFileCacheKey({ diffText: '+bar' });
    expect(a).not.toBe(b);
  });

  it('invalidates when the prompt version changes', () => {
    const a = computeFileCacheKey({ diffText: '+x', promptVersion: 'v1' });
    const b = computeFileCacheKey({ diffText: '+x', promptVersion: 'v2' });
    expect(a).not.toBe(b);
  });

  it('does not include model id (cross-model reuse)', () => {
    // No way to pass model id any more; ensure two calls with same args yield
    // identical hashes.
    expect(computeFileCacheKey({ diffText: '+x' })).toBe(computeFileCacheKey({ diffText: '+x' }));
  });
});

describe('getMany', () => {
  it('returns an empty Map when given no hashes', async () => {
    const result = await getMany([]);
    expect(result.size).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('selects rows by content_hash and parses JSON summaries', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          { content_hash: 'h1', summary: { description: 'desc1', risk: 'low' } },
          { content_hash: 'h2', summary: '{"description":"desc2","risk":"high"}' },
        ],
      })
      // Hit-count bump (fire-and-forget).
      .mockResolvedValueOnce({ rows: [] });

    const result = await getMany(['h1', 'h2', 'h3']);
    expect(result.size).toBe(2);
    expect(result.get('h1')).toEqual({ description: 'desc1', risk: 'low' });
    expect(result.get('h2')).toEqual({ description: 'desc2', risk: 'high' });
    expect(result.has('h3')).toBe(false);

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0]).toContain('SELECT content_hash, summary FROM walkthrough_file_cache');
    expect(queryMock.mock.calls[0][0]).toContain('IN ($1, $2, $3)');
  });

  it('drops malformed cached rows instead of throwing', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { content_hash: 'h1', summary: 'not valid json' },
        { content_hash: 'h2', summary: { description: '', risk: 'low' } }, // empty desc
        { content_hash: 'h3', summary: { description: 'good', risk: 'unknown' } },
      ],
    });

    const result = await getMany(['h1', 'h2', 'h3']);
    expect(result.has('h1')).toBe(false);
    expect(result.has('h2')).toBe(false);
    // 'unknown' risk should normalize to 'low'.
    expect(result.get('h3')).toEqual({ description: 'good', risk: 'low' });
  });

  it('deduplicates input hashes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await getMany(['h1', 'h1', 'h2', 'h2']);
    expect(queryMock.mock.calls[0][1]).toEqual(['h1', 'h2']);
  });
});

describe('putMany', () => {
  it('no-ops on empty input', async () => {
    await putMany([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('builds a single multi-row INSERT ... ON CONFLICT statement', async () => {
    await putMany([
      { contentHash: 'h1', summary: { description: 'a', risk: 'low' } },
      { contentHash: 'h2', summary: { description: 'b', risk: 'medium' }, modelId: 'haiku' },
    ]);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO walkthrough_file_cache');
    expect(sql).toContain('ON CONFLICT (content_hash) DO UPDATE');
    expect(sql).toContain('($1, $2, $3, $4)');
    expect(sql).toContain('($5, $6, $7, $8)');
    expect(params).toEqual([
      'h1', WALKTHROUGH_PROMPT_VERSION, null, JSON.stringify({ description: 'a', risk: 'low' }),
      'h2', WALKTHROUGH_PROMPT_VERSION, 'haiku', JSON.stringify({ description: 'b', risk: 'medium' }),
    ]);
  });

  it('skips entries with missing fields', async () => {
    await putMany([
      { contentHash: 'h1', summary: { description: 'good', risk: 'low' } },
      { contentHash: '', summary: { description: 'hash missing', risk: 'low' } },
      { contentHash: 'h2', summary: { description: '', risk: 'low' } },
      null,
    ]);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const params = queryMock.mock.calls[0][1];
    // Only the first valid row should be inserted (4 params per row).
    expect(params).toHaveLength(4);
    expect(params[0]).toBe('h1');
  });
});
