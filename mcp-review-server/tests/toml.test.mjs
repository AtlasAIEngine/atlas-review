import test from 'node:test';
import assert from 'node:assert/strict';

import { findTomlSectionRanges, normalizeTomlSectionName } from '../dist/src/setup/toml.js';

test('normalizeTomlSectionName handles quoted dotted keys', () => {
  assert.equal(
    normalizeTomlSectionName('mcp_servers."atlas-review".env'),
    'mcp_servers.atlas-review.env'
  );
  assert.equal(
    normalizeTomlSectionName('"mcp.servers"."atlas-review"'),
    'mcp.servers.atlas-review'
  );
  assert.equal(
    normalizeTomlSectionName("mcp_servers.'atlas\\\\review'.env"),
    'mcp_servers.atlas\\\\review.env'
  );
});

test('findTomlSectionRanges returns stable header ranges', () => {
  const input = [
    '[first]',
    'a = 1',
    '',
    '[mcp_servers."atlas-review"]',
    'command = "node"',
    'args = ["server.js"]',
    '',
    '[mcp_servers."atlas-review".env]',
    'ATLAS_BACKEND_URL = "http://127.0.0.1:3000/api"',
    '',
    '[last]',
    'z = 1',
    '',
  ].join('\n');

  const ranges = findTomlSectionRanges(input);
  assert.deepEqual(
    ranges.map((entry) => entry.name),
    ['first', 'mcp_servers.atlas-review', 'mcp_servers.atlas-review.env', 'last']
  );

  const atlasSection = ranges.find((entry) => entry.name === 'mcp_servers.atlas-review');
  const envSection = ranges.find((entry) => entry.name === 'mcp_servers.atlas-review.env');
  assert.ok(atlasSection);
  assert.ok(envSection);
  assert.equal(atlasSection.startLine, 3);
  assert.equal(atlasSection.endLine, 6);
  assert.equal(envSection.startLine, 7);
  assert.equal(envSection.endLine, 9);
});

test('findTomlSectionRanges ignores array-of-table headers', () => {
  const input = [
    '[[mcp_servers."atlas-review"]]',
    'command = "node"',
    '',
    '[regular]',
    'k = "v"',
    '',
  ].join('\n');

  const ranges = findTomlSectionRanges(input);
  assert.deepEqual(ranges.map((entry) => entry.name), ['regular']);
});
