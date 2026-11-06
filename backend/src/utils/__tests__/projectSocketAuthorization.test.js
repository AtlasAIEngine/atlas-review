import { describe, expect, it } from 'vitest';

import {
  ANONYMOUS_USER_ID,
  canAccessProjectFromSocket,
  getSocketUserId,
} from '../projectSocketAuthorization.js';

describe('project socket authorization', () => {
  it('resolves authenticated socket users from request or socket state', () => {
    expect(getSocketUserId({ request: { user: { id: 'request-user' } } })).toBe('request-user');
    expect(getSocketUserId({ user: { id: 'socket-user' } })).toBe('socket-user');
    expect(getSocketUserId({})).toBeNull();
  });

  it('allows the owning socket user to access an owned project', () => {
    expect(canAccessProjectFromSocket(
      { user_id: 'owner-user' },
      { request: { user: { id: 'owner-user' } } },
    )).toBe(true);
  });

  it('denies non-owners for owned projects', () => {
    expect(canAccessProjectFromSocket(
      { user_id: 'owner-user' },
      { request: { user: { id: 'other-user' } } },
    )).toBe(false);
    expect(canAccessProjectFromSocket({ user_id: 'owner-user' }, {})).toBe(false);
  });

  it('preserves anonymous project access for MVP sockets', () => {
    expect(canAccessProjectFromSocket({ user_id: ANONYMOUS_USER_ID }, {})).toBe(true);
  });
});
