import { expect, test } from '@playwright/test';
import { DiffHunk } from '../DiffHunk';
import { tokenize } from '../tokenize';

test.describe('tokenize', () => {
  test('preserves leading whitespace as an untokenized span', () => {
    const tokens = tokenize('    const x = 1;');
    expect(tokens[0]).toEqual({ text: '    ' });
    expect(tokens.some(t => t.text === 'const' && t.token === 'keyword')).toBe(true);
    expect(tokens.some(t => t.text === '1' && t.token === 'number')).toBe(true);
  });

  test('marks double-quoted strings as string tokens', () => {
    const tokens = tokenize('const greeting = "hello world";');
    expect(tokens.some(t => t.text === '"hello world"' && t.token === 'string')).toBe(true);
  });

  test('dims trailing // comments', () => {
    const tokens = tokenize('int count = 5; // inclusive');
    const commentToken = tokens.find(t => t.token === 'comment');
    expect(commentToken).toBeDefined();
    expect(commentToken?.text).toBe('// inclusive');
  });

  test('non-keyword identifiers come through untokenized', () => {
    const tokens = tokenize('customName.doThing()');
    const identifier = tokens.find(t => t.text === 'customName');
    expect(identifier).toBeDefined();
    expect(identifier?.token).toBeUndefined();
  });

  test('empty input still yields the leading-whitespace span', () => {
    const tokens = tokenize('');
    expect(tokens).toEqual([{ text: '' }]);
  });

  test('keyword detection is case-sensitive (TODO matches, todo does not)', () => {
    const todoTokens = tokenize('// TODO: replace this');
    // TODO is inside a comment so whole tail becomes a comment token
    expect(todoTokens.some(t => t.token === 'comment' && t.text.includes('TODO'))).toBe(true);
    const barewordTokens = tokenize('todo.run();');
    expect(barewordTokens.some(t => t.text === 'todo' && t.token === undefined)).toBe(true);
  });
});

test.describe('DiffHunk', () => {
  // Playwright intercepts the JSX runtime and returns `__pw_type` descriptors,
  // so we can't meaningfully render React in this test runner. Instead verify
  // the component is exported as a renderable function and that the tokenizer
  // (its only non-style logic) behaves correctly for each of the three line
  // kinds it consumes.
  test('exports DiffHunk as a function component', () => {
    expect(typeof DiffHunk).toBe('function');
    expect(DiffHunk.length).toBeGreaterThan(0);
  });

  test('tokenizer preserves added-line content unchanged', () => {
    const addedText = 'public void Run() {';
    const tokens = tokenize(addedText);
    const rebuilt = tokens.map(t => t.text).join('');
    expect(rebuilt).toBe(addedText);
    expect(tokens.some(t => t.token === 'keyword' && t.text === 'public')).toBe(true);
  });

  test('tokenizer preserves deleted-line content unchanged', () => {
    const deletedText = '    return "removed";';
    const tokens = tokenize(deletedText);
    expect(tokens.map(t => t.text).join('')).toBe(deletedText);
    expect(tokens.some(t => t.token === 'string' && t.text === '"removed"')).toBe(true);
  });
});
