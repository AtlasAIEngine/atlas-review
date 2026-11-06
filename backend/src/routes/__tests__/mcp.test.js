import { describe, expect, it } from 'vitest';

import { __testing } from '../mcp.js';

function createReq({ host = '', protocol = 'http', forwardedProto = '' } = {}) {
  const headers = {};
  if (host) headers.host = host;
  if (forwardedProto) headers['x-forwarded-proto'] = forwardedProto;
  return {
    protocol,
    headers,
    get(name) {
      return headers[String(name || '').toLowerCase()];
    },
  };
}

describe('mcp route backend URL resolution', () => {
  it('falls back to current request host when backendUrl is omitted', () => {
    const req = createReq({
      host: '127.0.0.1:52779',
      protocol: 'http',
    });

    expect(__testing.resolveBackendUrl(req, undefined)).toBe('http://127.0.0.1:52779/api');
  });

  it('prefers explicit backendUrl when provided', () => {
    const req = createReq({
      host: '127.0.0.1:52779',
      protocol: 'http',
    });

    expect(__testing.resolveBackendUrl(req, 'http://127.0.0.1:55185/api')).toBe('http://127.0.0.1:55185/api');
  });

  it('honors forwarded proto when deriving the current backend URL', () => {
    const req = createReq({
      host: 'atlasengine.dev',
      protocol: 'http',
      forwardedProto: 'https',
    });

    expect(__testing.resolveBackendUrl(req, undefined)).toBe('https://atlasengine.dev/api');
  });

  it('returns undefined when host header is missing', () => {
    const req = createReq({ host: '' });
    expect(__testing.resolveBackendUrl(req, undefined)).toBeUndefined();
  });

  it('throws for a host that produces an invalid URL', () => {
    const req = createReq({ host: 'not a valid host' });
    expect(() => __testing.resolveBackendUrl(req, undefined)).toThrow();
  });
});
