import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractBearerToken, verifyJWTToken } from '../auth.js';

const originalJwtSecret = process.env.JWT_SECRET;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  console.warn = vi.fn();
});

afterEach(() => {
  if (originalJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalJwtSecret;
  }
  console.warn = originalConsoleWarn;
});

describe('auth helpers', () => {
  it('extracts bearer tokens from authorization headers', () => {
    expect(extractBearerToken('Bearer test-token')).toBe('test-token');
    expect(extractBearerToken('Bearer   test-token  ')).toBe('test-token');
    expect(extractBearerToken('Basic test-token')).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });

  it('verifies JWTs into request user shape', () => {
    process.env.JWT_SECRET = 'test-secret';
    const token = jwt.sign({
      id: 'user-1',
      email: 'user@example.com',
      is_admin: true,
      plan: 'pro',
    }, process.env.JWT_SECRET);

    expect(verifyJWTToken(token)).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      is_admin: true,
      plan: 'pro',
    });
  });

  it('treats invalid or unverifiable JWTs as unauthenticated', () => {
    process.env.JWT_SECRET = 'test-secret';
    expect(verifyJWTToken('not-a-jwt')).toBeNull();
    expect(verifyJWTToken(jwt.sign({ email: 'user@example.com' }, process.env.JWT_SECRET))).toBeNull();

    delete process.env.JWT_SECRET;
    expect(verifyJWTToken(jwt.sign({ id: 'user-1' }, 'test-secret'))).toBeNull();
  });
});
