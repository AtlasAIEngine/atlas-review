import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRuntimeMcpFixture } from './runtimeMcpFixture.js';
import { createGetDiffForFileHandler } from '../tools/getDiffForFile.js';
import { createReadFileSliceHandler } from '../tools/readFileSlice.js';
import { createGetHunkContextHandler } from '../tools/getHunkContext.js';

describe('runtime MCP tools — against synthetic git fixture', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await createRuntimeMcpFixture();
  });
  afterAll(async () => {
    if (fixture) await fixture.cleanup();
  });

  describe('get_diff_for_file', () => {
    it('returns the unified diff for a changed file', async () => {
      const handle = createGetDiffForFileHandler({
        projectRoot: fixture.repoPath,
        mergeBaseSha: fixture.baseSha,
        headSha: fixture.headSha,
      });
      const result = await handle({ path: 'src/foo.js' });
      const text = result.content[0].text;
      expect(text).toContain('--- a/src/foo.js');
      expect(text).toContain('+++ b/src/foo.js');
      expect(text).toContain('-  const y = 2;');
      expect(text).toContain('+  const y = 99;');
    });

    it('returns the diff for a file added in head', async () => {
      const handle = createGetDiffForFileHandler({
        projectRoot: fixture.repoPath,
        mergeBaseSha: fixture.baseSha,
        headSha: fixture.headSha,
      });
      const result = await handle({ path: 'src/bar.js' });
      const text = result.content[0].text;
      expect(text).toContain('+++ b/src/bar.js');
      expect(text).toContain('+export function bar');
    });

    it('returns "no diff" message for an unchanged path', async () => {
      const handle = createGetDiffForFileHandler({
        projectRoot: fixture.repoPath,
        mergeBaseSha: fixture.baseSha,
        headSha: fixture.headSha,
      });
      const result = await handle({ path: 'src/nonexistent.js' });
      expect(result.content[0].text).toMatch(/no diff|unchanged|outside changeset/);
    });

    it('rejects paths that escape the project root', async () => {
      const handle = createGetDiffForFileHandler({
        projectRoot: fixture.repoPath,
        mergeBaseSha: fixture.baseSha,
        headSha: fixture.headSha,
      });
      await expect(handle({ path: '../escape.txt' })).rejects.toThrow(/outside project root/);
    });

    it('throws on construction with invalid SHA', () => {
      expect(() => createGetDiffForFileHandler({
        projectRoot: fixture.repoPath,
        mergeBaseSha: 'not-a-sha',
        headSha: fixture.headSha,
      })).toThrow(/mergeBaseSha must be a valid hex SHA/);
    });
  });

  describe('read_file_slice', () => {
    it('returns numbered lines [start..end] inclusive at head', async () => {
      const handle = createReadFileSliceHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      const result = await handle({ path: 'src/foo.js', startLine: 2, endLine: 4 });
      const text = result.content[0].text;
      expect(text).toContain('2\t  const x = 1;');
      expect(text).toContain('3\t  const y = 99;');
      expect(text).toContain('4\t  return x + y;');
      // line 1 and line 5 should NOT appear
      expect(text).not.toMatch(/^1\t/m);
      expect(text).not.toMatch(/^5\t/m);
    });

    it('clamps endLine to EOF when requested span goes past the file', async () => {
      const handle = createReadFileSliceHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      const result = await handle({ path: 'src/foo.js', startLine: 4, endLine: 200 });
      const text = result.content[0].text;
      expect(text).toContain('clamped to EOF');
    });

    it('returns past-EOF message when startLine is past EOF', async () => {
      const handle = createReadFileSliceHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      const result = await handle({ path: 'src/foo.js', startLine: 9999, endLine: 9999 });
      expect(result.content[0].text).toMatch(/past EOF/);
    });

    it('rejects span > 500 lines', async () => {
      const handle = createReadFileSliceHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      await expect(handle({ path: 'src/foo.js', startLine: 1, endLine: 502 })).rejects.toThrow(/exceeds cap 500/);
    });

    it('rejects endLine < startLine', async () => {
      const handle = createReadFileSliceHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      await expect(handle({ path: 'src/foo.js', startLine: 5, endLine: 2 })).rejects.toThrow(/integer >= startLine/);
    });

    it('rejects path traversal', async () => {
      const handle = createReadFileSliceHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      await expect(handle({ path: '../etc/passwd', startLine: 1, endLine: 5 })).rejects.toThrow(/outside project root/);
    });
  });

  describe('get_hunk_context', () => {
    it('returns a window of N lines on each side, anchor-marked', async () => {
      const handle = createGetHunkContextHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      const result = await handle({ path: 'src/foo.js', line: 3, contextLines: 2 });
      const text = result.content[0].text;
      // anchor line is 3, +-2 lines → expect lines 1..5
      expect(text).toContain('lines 1-5');
      expect(text).toContain('anchor: 3');
      expect(text).toContain('>>3\t  const y = 99;');
      // surrounding lines must NOT have the anchor marker
      expect(text).toMatch(/  1\texport function foo/);
      expect(text).toMatch(/  2\t  const x = 1;/);
    });

    it('clamps to file boundaries', async () => {
      const handle = createGetHunkContextHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      const result = await handle({ path: 'src/foo.js', line: 2, contextLines: 100 });
      const text = result.content[0].text;
      // file has 6 lines (5 + trailing newline → split gives 6), context capped at file bounds
      expect(text).toMatch(/lines 1-/);
    });

    it('uses default context of 20 when contextLines omitted', async () => {
      const handle = createGetHunkContextHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      const result = await handle({ path: 'src/bar.js', line: 5 });
      const text = result.content[0].text;
      // bar.js has 10 lines; default 20 each side → clamps to 1..10
      expect(text).toContain('lines 1-10');
    });

    it('returns past-EOF message when line is past EOF', async () => {
      const handle = createGetHunkContextHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      const result = await handle({ path: 'src/foo.js', line: 9999 });
      expect(result.content[0].text).toMatch(/past EOF/);
    });

    it('rejects contextLines > 100', async () => {
      const handle = createGetHunkContextHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      await expect(handle({ path: 'src/foo.js', line: 3, contextLines: 101 })).rejects.toThrow(/contextLines must be an integer/);
    });

    it('rejects path traversal', async () => {
      const handle = createGetHunkContextHandler({
        projectRoot: fixture.repoPath,
        headSha: fixture.headSha,
      });
      await expect(handle({ path: '../escape.txt', line: 1 })).rejects.toThrow(/outside project root/);
    });
  });
});
