import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRuntimeMcpFixture } from './runtimeMcpFixture.js';
import { buildRuntimeMcpServer, SERVER_NAME } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('runtime MCP server — end-to-end via in-memory transport', () => {
  let fixture;
  let client;
  let server;

  beforeAll(async () => {
    fixture = await createRuntimeMcpFixture();
    server = buildRuntimeMcpServer({
      projectRoot: fixture.repoPath,
      mergeBaseSha: fixture.baseSha,
      headSha: fixture.headSha,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.close();
    if (fixture) await fixture.cleanup();
  });

  it('advertises 3 tools via tools/list', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_diff_for_file', 'get_hunk_context', 'read_file_slice']);
  });

  it('serves get_diff_for_file via tools/call', async () => {
    const result = await client.callTool({
      name: 'get_diff_for_file',
      arguments: { path: 'src/foo.js' },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('+  const y = 99;');
  });

  it('serves get_hunk_context via tools/call', async () => {
    const result = await client.callTool({
      name: 'get_hunk_context',
      arguments: { path: 'src/bar.js', line: 5, contextLines: 1 },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('anchor: 5');
  });

  it('serves read_file_slice via tools/call', async () => {
    const result = await client.callTool({
      name: 'read_file_slice',
      arguments: { path: 'src/foo.js', startLine: 1, endLine: 2 },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('1\texport function foo()');
  });

  it('returns isError result on unknown tool', async () => {
    const result = await client.callTool({
      name: 'no_such_tool',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });

  it('returns isError result when handler throws (path traversal)', async () => {
    const result = await client.callTool({
      name: 'read_file_slice',
      arguments: { path: '../escape.txt', startLine: 1, endLine: 5 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outside project root/);
  });
});

describe('runtime MCP server — config validation', () => {
  it('throws on missing projectRoot', () => {
    expect(() => buildRuntimeMcpServer({ mergeBaseSha: 'abcd1234', headSha: 'beef0000' })).toThrow(/projectRoot is required/);
  });

  it('throws on invalid mergeBaseSha', () => {
    expect(() => buildRuntimeMcpServer({ projectRoot: '/tmp', mergeBaseSha: 'not-a-sha', headSha: 'beef0000' })).toThrow(/mergeBaseSha/);
  });

  it('throws on invalid headSha', () => {
    expect(() => buildRuntimeMcpServer({ projectRoot: '/tmp', mergeBaseSha: 'abcd1234', headSha: 'oops' })).toThrow(/headSha/);
  });
});

describe('SERVER_NAME', () => {
  it('exposes the canonical server name (used as MCP namespace prefix)', () => {
    expect(SERVER_NAME).toBe('atlas-review-rt');
  });
});
