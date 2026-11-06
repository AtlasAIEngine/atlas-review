import { describe, it, expect } from 'vitest';
import { resolveSafeProjectPath, relativeToProjectRoot } from '../pathSafety.js';

describe('resolveSafeProjectPath', () => {
  const root = '/abs/project';

  it('resolves a simple relative path', () => {
    expect(resolveSafeProjectPath(root, 'src/foo.js')).toBe('/abs/project/src/foo.js');
  });

  it('resolves nested directories', () => {
    expect(resolveSafeProjectPath(root, 'a/b/c/d.txt')).toBe('/abs/project/a/b/c/d.txt');
  });

  it('rejects path that escapes root via ..', () => {
    expect(() => resolveSafeProjectPath(root, '../etc/passwd')).toThrow(/outside project root/);
  });

  it('rejects deep traversal escape', () => {
    expect(() => resolveSafeProjectPath(root, 'a/b/../../../etc/passwd')).toThrow(/outside project root/);
  });

  it('rejects an absolute path that points outside the project', () => {
    expect(() => resolveSafeProjectPath(root, '/etc/passwd')).toThrow(/outside project root/);
  });

  it('accepts an absolute path that equals or is under the project root', () => {
    expect(resolveSafeProjectPath(root, '/abs/project/src/foo.js')).toBe('/abs/project/src/foo.js');
  });

  it('rejects an absolute path that prefix-matches but is not under the root', () => {
    // /abs/project-evil starts with /abs/project but is a sibling, not nested.
    // Without the trailing-separator guard this would slip through.
    expect(() => resolveSafeProjectPath(root, '/abs/project-evil/foo')).toThrow(/outside project root/);
  });

  it('rejects empty string', () => {
    expect(() => resolveSafeProjectPath(root, '')).toThrow(/path is required/);
  });

  it('rejects non-string', () => {
    expect(() => resolveSafeProjectPath(root, null)).toThrow(/path is required/);
    expect(() => resolveSafeProjectPath(root, 42)).toThrow(/path is required/);
  });

  it('rejects empty projectRoot', () => {
    expect(() => resolveSafeProjectPath('', 'foo')).toThrow(/projectRoot is required/);
  });
});

describe('relativeToProjectRoot', () => {
  it('returns the relative path inside root', () => {
    expect(relativeToProjectRoot('/abs/project', '/abs/project/src/foo.js')).toBe('src/foo.js');
  });

  it('returns empty string for the root itself', () => {
    expect(relativeToProjectRoot('/abs/project', '/abs/project')).toBe('');
  });
});
