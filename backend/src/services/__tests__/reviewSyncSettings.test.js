import { afterEach, expect, it } from 'vitest';
import { seedDefaultReviewSyncEnv } from '../reviewSyncSettings.js';
const original = process.env.ATLAS_REVIEW_SYNC_SERVER_URL;
afterEach(() => {
  if (original === undefined) delete process.env.ATLAS_REVIEW_SYNC_SERVER_URL;
  else process.env.ATLAS_REVIEW_SYNC_SERVER_URL = original;
});
it('does not opt a fresh installation into a hosted sync server', () => {
  delete process.env.ATLAS_REVIEW_SYNC_SERVER_URL;
  expect(seedDefaultReviewSyncEnv()).toBe(false);
  expect(process.env.ATLAS_REVIEW_SYNC_SERVER_URL).toBeUndefined();
});
it('preserves an explicitly configured sync server', () => {
  process.env.ATLAS_REVIEW_SYNC_SERVER_URL = 'https://sync.example.test';
  expect(seedDefaultReviewSyncEnv()).toBe(false);
  expect(process.env.ATLAS_REVIEW_SYNC_SERVER_URL).toBe('https://sync.example.test');
});
