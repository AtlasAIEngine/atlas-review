import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBackendUrl } from '../dist/src/config.js';
import { normalizeSetupBackendUrl } from '../dist/src/setup/configGenerator.js';

test('normalizeBackendUrl preserves explicit custom API base paths', () => {
  assert.equal(
    normalizeBackendUrl('https://atlas.example.com/internal/v2/review-api'),
    'https://atlas.example.com/internal/v2/review-api'
  );
});

test('normalizeBackendUrl adds /api only when path is empty', () => {
  assert.equal(normalizeBackendUrl('127.0.0.1:50858'), 'http://127.0.0.1:50858/api');
  assert.equal(normalizeBackendUrl('https://atlas.example.com/'), 'https://atlas.example.com/api');
});

test('normalizeBackendUrl keeps non-http schemes unchanged', () => {
  assert.equal(normalizeBackendUrl('unix:///tmp/atlas.sock'), 'unix:///tmp/atlas.sock');
});

test('normalizeSetupBackendUrl mirrors backend URL normalization behavior', () => {
  assert.equal(
    normalizeSetupBackendUrl('https://atlas.example.com/internal/v2/review-api'),
    'https://atlas.example.com/internal/v2/review-api'
  );
  assert.equal(normalizeSetupBackendUrl('localhost:8080'), 'http://localhost:8080/api');
  assert.equal(normalizeSetupBackendUrl('https://atlas.example.com/'), 'https://atlas.example.com/api');
});
