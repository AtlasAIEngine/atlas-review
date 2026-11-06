import { describe, expect, it } from 'vitest';

import { generateDiffFromFiles } from '../reviewDiff.js';

describe('generateDiffFromFiles', () => {
  it('preserves rename relationships in synthetic diffs', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/new-name.ts',
        oldPath: 'src/old-name.ts',
        before: 'export const value = 1;\n',
        after: 'export const value = 1;\n',
      },
    ]);

    expect(diff).toContain('diff --git a/src/old-name.ts b/src/new-name.ts');
    expect(diff).toContain('rename from src/old-name.ts');
    expect(diff).toContain('rename to src/new-name.ts');
    expect(diff).toContain('similarity index 100%');
    expect(diff).not.toContain('new file');
    expect(diff).not.toContain('deleted file');
  });

  it('shows both rename metadata and content edits for renamed files', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/new-name.ts',
        oldPath: 'src/old-name.ts',
        before: 'export const value = 1;\n',
        after: 'export const value = 2;\n',
      },
    ]);

    expect(diff).toContain('diff --git a/src/old-name.ts b/src/new-name.ts');
    expect(diff).toContain('rename from src/old-name.ts');
    expect(diff).toContain('rename to src/new-name.ts');
    expect(diff).toContain('--- a/src/old-name.ts');
    expect(diff).toContain('+++ b/src/new-name.ts');
    expect(diff).toContain('-export const value = 1;');
    expect(diff).toContain('+export const value = 2;');
  });

  it('uses the old path in patch headers for renamed files', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/new-name.ts',
        oldPath: 'src/old-name.ts',
        before: 'line one\nline two\n',
        after: 'line one\nline changed\n',
      },
    ]);

    expect(diff).toContain('--- a/src/old-name.ts');
    expect(diff).toContain('+++ b/src/new-name.ts');
  });

  it('omits similarity metadata when a renamed file also changes content', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/new-name.ts',
        oldPath: 'src/old-name.ts',
        before: 'export const value = 1;\n',
        after: 'export const value = 2;\n',
      },
    ]);

    expect(diff).not.toContain('similarity index 100%');
    expect(diff).toContain('@@ -1,1 +1,1 @@');
  });

  it('represents pure renames without collapsing them into add delete pairs', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/moved.ts',
        oldPath: 'src/original.ts',
        before: 'export function moved() {}\n',
        after: 'export function moved() {}\n',
      },
    ]);

    expect(diff).toContain('rename from src/original.ts');
    expect(diff).toContain('rename to src/moved.ts');
    expect(diff).not.toContain('--- /dev/null');
    expect(diff).not.toContain('+++ /dev/null');
    expect(diff).not.toContain('@@ -0,0 +1,1 @@');
    expect(diff).not.toContain('@@ -1,1 +0,0 @@');
  });

  it('does not emit empty placeholder hunks for pure renames', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/renamed.ts',
        oldPath: 'src/original.ts',
        before: 'const unchanged = true;\n',
        after: 'const unchanged = true;\n',
      },
    ]);

    expect(diff).not.toContain('@@ -0,0 +0,0 @@');
  });

  it('leaves non-rename diffs unchanged', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/example.ts',
        before: 'export const value = 1;\n',
        after: 'export const value = 2;\n',
      },
    ]);

    expect(diff).toContain('diff --git a/src/example.ts b/src/example.ts');
    expect(diff).toContain('--- a/src/example.ts');
    expect(diff).toContain('+++ b/src/example.ts');
    expect(diff).not.toContain('rename from');
    expect(diff).not.toContain('rename to');
  });

  it('does not infer rename metadata when oldPath matches the current path', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/example.ts',
        oldPath: 'src/example.ts',
        before: 'export const value = 1;\n',
        after: 'export const value = 2;\n',
      },
    ]);

    expect(diff).not.toContain('rename from');
    expect(diff).not.toContain('rename to');
    expect(diff).toContain('diff --git a/src/example.ts b/src/example.ts');
  });

  it('keeps added file rendering unchanged', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/added.ts',
        before: null,
        after: 'export const added = true;\n',
      },
    ]);

    expect(diff).toContain('diff --git a/src/added.ts b/src/added.ts');
    expect(diff).toContain('new file');
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/src/added.ts');
  });

  it('keeps deleted file rendering unchanged', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/deleted.ts',
        before: 'export const removed = true;\n',
        after: null,
      },
    ]);

    expect(diff).toContain('diff --git a/src/deleted.ts b/src/deleted.ts');
    expect(diff).toContain('deleted file');
    expect(diff).toContain('--- a/src/deleted.ts');
    expect(diff).toContain('+++ /dev/null');
  });

  it('uses supplied patch text when before and after content are unavailable', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/example.ts',
        before: null,
        after: null,
        patch: '@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;',
      },
    ]);

    expect(diff).toContain('diff --git a/src/example.ts b/src/example.ts');
    expect(diff).toContain('--- a/src/example.ts');
    expect(diff).toContain('+++ b/src/example.ts');
    expect(diff).toContain('-export const value = 1;');
    expect(diff).toContain('+export const value = 2;');
  });

  it('separates supplied patch text from following file headers', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/one.ts',
        before: null,
        after: null,
        patch: '@@ -1,1 +1,1 @@\n-export const one = 1;\n+export const one = 2;',
      },
      {
        path: 'src/two.ts',
        before: null,
        after: null,
        patch: '@@ -1,1 +1,1 @@\n-export const two = 1;\n+export const two = 2;',
      },
    ]);

    expect(diff).toContain('+export const one = 2;\n\ndiff --git a/src/two.ts b/src/two.ts');
  });

  it('preserves trailing whitespace inside supplied patch lines', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'src/padded.ts',
        before: null,
        after: null,
        patch: '@@ -1,1 +1,1 @@\n-export const padded = false;\n+export const padded = true;   \n',
      },
    ]);

    expect(diff).toContain('+export const padded = true;   \n');
  });

  it('skips renamed lock files using the destination path', () => {
    const diff = generateDiffFromFiles([
      {
        path: 'packages/app/package-lock.json',
        oldPath: 'packages/app/package-lock.old.json',
        before: '{\n  "lockfileVersion": 2\n}\n',
        after: '{\n  "lockfileVersion": 3\n}\n',
      },
    ]);

    expect(diff).toContain('# Note: 1 lock/generated file(s) excluded from review: packages/app/package-lock.json');
    expect(diff).not.toContain('rename from packages/app/package-lock.old.json');
  });
});
