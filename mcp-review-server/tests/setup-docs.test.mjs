import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const docsPath = path.join(process.cwd(), 'docs', 'setup-support-matrix.md');
const readmePath = path.join(process.cwd(), 'README.md');

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

test('support matrix captures verified v1 agent statuses', async () => {
  const matrix = await readText(docsPath);

  for (const agent of ['Claude Code', 'Claude Desktop', 'Codex', 'VS Code', 'Cursor']) {
    assert.match(matrix, new RegExp(`\\|\\s*${agent}\\s*\\|`, 'u'));
  }

  for (const status of ['shipped', 'experimental', 'deferred']) {
    assert.match(matrix, new RegExp(`\\b${status}\\b`, 'u'));
  }
});

test('README points to the verified support matrix and avoids unverified setup examples', async () => {
  const readme = await readText(readmePath);

  assert.match(readme, /docs\/setup-support-matrix\.md/u);
  assert.match(readme, /first-run setup wizard/u);
  assert.match(readme, /Settings > MCP/u);
  assert.doesNotMatch(readme, /setup --agent=gemini/u);
});
