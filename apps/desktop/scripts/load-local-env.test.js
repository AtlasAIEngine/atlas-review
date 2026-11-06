import { describe, expect, it } from 'vitest';

import { parseEnvFile } from './load-local-env.js';

describe('parseEnvFile', () => {
  it('strips inline comments from unquoted values', () => {
    expect(
      parseEnvFile('TAURI_SIGNING_PRIVATE_KEY=abc123 # local signing key')
    ).toEqual([
      ['TAURI_SIGNING_PRIVATE_KEY', 'abc123'],
    ]);
  });

  it('preserves # characters inside quoted values', () => {
    expect(
      parseEnvFile('TAURI_SIGNING_PRIVATE_KEY="abc123 # local signing key"')
    ).toEqual([
      ['TAURI_SIGNING_PRIVATE_KEY', 'abc123 # local signing key'],
    ]);
  });

  it('preserves # characters that are not preceded by whitespace', () => {
    expect(
      parseEnvFile('TAURI_SIGNING_PRIVATE_KEY=abc123#local-signing-key')
    ).toEqual([
      ['TAURI_SIGNING_PRIVATE_KEY', 'abc123#local-signing-key'],
    ]);
  });

  it('preserves # characters inside single-quoted values', () => {
    expect(
      parseEnvFile("TAURI_SIGNING_PRIVATE_KEY='abc123 # local signing key'")
    ).toEqual([
      ['TAURI_SIGNING_PRIVATE_KEY', 'abc123 # local signing key'],
    ]);
  });

  it('treats comment-only values as empty strings', () => {
    expect(
      parseEnvFile('TAURI_SIGNING_PRIVATE_KEY= # local signing key')
    ).toEqual([
      ['TAURI_SIGNING_PRIVATE_KEY', ''],
    ]);
  });
});
