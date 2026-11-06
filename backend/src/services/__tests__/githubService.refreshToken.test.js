/**
 * GitHub Service - Device Token Refresh Tests
 *
 * Tests the auto-refresh flow for GitHub device flow (OAuth) tokens:
 * 1. refreshDeviceToken() calls GitHub and stores rotated tokens
 * 2. getInstallationClient() auto-refreshes expired device tokens
 * 3. getDecryptedToken() auto-refreshes expired device tokens
 * 4. Fallback to re-auth when refresh token is missing or expired
 * 5. storeDeviceTokenForUser() stores refresh token + real expiry
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';

// Mock the database connection
vi.mock('../../db/connection.js', () => ({
  default: { query: vi.fn() },
  query: vi.fn(),
}));

// Mock encryption utilities — use simple reversible encoding for testing
vi.mock('../../utils/encryption.js', () => ({
  encrypt: vi.fn((plaintext) => `encrypted:${plaintext}`),
  decrypt: vi.fn((ciphertext) => {
    if (!ciphertext.startsWith('encrypted:')) {
      throw new Error('Decryption failed: invalid format');
    }
    return ciphertext.replace('encrypted:', '');
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

const originalEnv = process.env;

describe('githubService - device token refresh', () => {
  let githubService;
  let dbMock;
  let encryptMock;
  let decryptMock;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    process.env = {
      ...originalEnv,
      ATLAS_DESKTOP_MODE: 'true',
      GITHUB_APP_CLIENT_ID: 'test-client-id',
      GITHUB_APP_CLIENT_SECRET: 'test-client-secret',
      ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    };

    const dbModule = await import('../../db/connection.js');
    dbMock = dbModule.default.query;

    const encModule = await import('../../utils/encryption.js');
    encryptMock = encModule.encrypt;
    decryptMock = encModule.decrypt;

    const module = await import('../githubService.js');
    githubService = module.default;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Helper: build a fake device-flow integration row
  function makeIntegration(overrides = {}) {
    return {
      installation_id: -1707000000000,
      user_id: '00000000-0000-0000-0000-000000000000',
      account_login: 'testuser',
      access_token_encrypted: 'encrypted:old-access-token',
      user_access_token_encrypted: 'encrypted:old-access-token',
      token_expires_at: new Date(Date.now() - 3600_000).toISOString(), // expired 1h ago
      refresh_token_encrypted: 'encrypted:old-refresh-token',
      refresh_token_expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(), // 90 days out
      is_active: true,
      ...overrides,
    };
  }

  // ─── refreshDeviceToken() ────────────────────────────────────────

  describe('refreshDeviceToken', () => {
    it('should call GitHub OAuth endpoint and store new tokens', async () => {
      const integration = makeIntegration();

      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 28800, // 8 hours
          refresh_token_expires_in: 15811200, // ~6 months
        }),
      });

      dbMock
        .mockResolvedValueOnce({ rows: [] }) // UPDATE current row
        .mockResolvedValueOnce({ rows: [] }); // sync sibling rows

      const newToken = await githubService.refreshDeviceToken(integration);

      expect(newToken).toBe('new-access-token');

      // Verify fetch was called with correct params
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://github.com/login/oauth/access_token');
      expect(opts.method).toBe('POST');

      const body = new URLSearchParams(opts.body);
      expect(body.get('client_id')).toBe('test-client-id');
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('old-refresh-token');
      expect(body.get('client_secret')).toBe('test-client-secret');

      // Verify DB was updated with encrypted new tokens
      expect(dbMock).toHaveBeenCalledTimes(2);
      const [sql, params] = dbMock.mock.calls[0];
      expect(sql).toContain('UPDATE github_integrations');
      expect(params[0]).toBe('encrypted:new-access-token'); // access_token_encrypted
      expect(params[2]).toBe('encrypted:new-access-token'); // user_access_token_encrypted
      expect(params[3]).toBe('encrypted:new-refresh-token'); // refresh_token_encrypted
      expect(params[5]).toBe(integration.installation_id);

      // Verify expiry is ~8 hours from now
      const tokenExpiry = new Date(params[1]);
      const expectedExpiry = Date.now() + 28800 * 1000;
      expect(Math.abs(tokenExpiry.getTime() - expectedExpiry)).toBeLessThan(5000);

      const [syncSql, syncParams] = dbMock.mock.calls[1];
      expect(syncSql).toContain('WHERE user_id = $5');
      expect(syncParams[0]).toBe(params[1]);
      expect(syncParams[1]).toBe('encrypted:new-access-token');
      expect(syncParams[2]).toBe('encrypted:new-refresh-token');
      expect(syncParams[4]).toBe(integration.user_id);
    });

    it('coalesces concurrent refreshes for the same stored refresh token', async () => {
      const integration = makeIntegration();

      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          access_token: 'shared-access-token',
          refresh_token: 'shared-refresh-token',
          expires_in: 28800,
          refresh_token_expires_in: 15811200,
        }),
      });

      dbMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const [firstToken, secondToken] = await Promise.all([
        githubService.refreshDeviceToken(integration),
        githubService.refreshDeviceToken({ ...integration }),
      ]);

      expect(firstToken).toBe('shared-access-token');
      expect(secondToken).toBe('shared-access-token');
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(dbMock).toHaveBeenCalledTimes(2);
    });

    it('should throw if no refresh_token_encrypted is stored', async () => {
      const integration = makeIntegration({ refresh_token_encrypted: null });

      await expect(githubService.refreshDeviceToken(integration))
        .rejects.toThrow('No refresh token available');
    });

    it('should throw if refresh_token itself is expired', async () => {
      const integration = makeIntegration({
        refresh_token_expires_at: new Date(Date.now() - 3600_000).toISOString(), // expired
      });

      await expect(githubService.refreshDeviceToken(integration))
        .rejects.toThrow('Refresh token has expired');
    });

    it('should throw if GitHub returns an error response', async () => {
      const integration = makeIntegration();

      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          error: 'bad_refresh_token',
          error_description: 'The refresh token is invalid.',
        }),
      });

      await expect(githubService.refreshDeviceToken(integration))
        .rejects.toThrow('The refresh token is invalid.');
    });

    it('should keep existing refresh_token if GitHub does not rotate it', async () => {
      const integration = makeIntegration();

      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          access_token: 'new-access-token',
          // no refresh_token in response — non-rotating mode
          expires_in: 28800,
        }),
      });

      dbMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await githubService.refreshDeviceToken(integration);

      const [, params] = dbMock.mock.calls[0];
      // Should keep the existing encrypted refresh token
      expect(params[3]).toBe(integration.refresh_token_encrypted);
      // Should keep the existing refresh_token_expires_at
      expect(params[4]).toBe(integration.refresh_token_expires_at);
    });
  });

  describe('user token auth errors', () => {
    it('normalizes decryption failures into reconnect-required auth errors', async () => {
      const integration = makeIntegration({
        token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        user_access_token_encrypted: 'broken-token',
        access_token_encrypted: 'broken-token',
        refresh_token_encrypted: null,
      });

      dbMock.mockResolvedValueOnce({ rows: [integration] });

      await expect(githubService.getInstallationClient(integration.installation_id)).rejects.toMatchObject({
        code: 'AUTH_EXPIRED',
        status: 401,
        message: 'GitHub credentials could not be decrypted. Please reconnect your GitHub account.',
      });
    });
  });

  // ─── getInstallationClient() auto-refresh ────────────────────────

  describe('getInstallationClient - auto-refresh', () => {
    it('should auto-refresh and return Octokit when device token is expired but refresh token is valid', async () => {
      const integration = makeIntegration();

      // getInstallationById returns the integration
      dbMock.mockResolvedValueOnce({ rows: [integration] });

      // refreshDeviceToken fetch
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          access_token: 'refreshed-token',
          refresh_token: 'rotated-refresh',
          expires_in: 28800,
          refresh_token_expires_in: 15811200,
        }),
      });

      // refreshDeviceToken DB updates
      dbMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [makeIntegration({
            installation_id: integration.installation_id,
            token_expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
            access_token_encrypted: 'encrypted:refreshed-token',
            user_access_token_encrypted: 'encrypted:refreshed-token',
          })],
        });

      const octokit = await githubService.getInstallationClient(integration.installation_id);

      // Should return an Octokit-like object (has .request method)
      expect(octokit).toBeDefined();
      expect(typeof octokit.request).toBe('function');

      // Verify the refresh fetch was called
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('should throw when device token is expired and no refresh token exists', async () => {
      const integration = makeIntegration({ refresh_token_encrypted: null });

      dbMock.mockResolvedValueOnce({ rows: [integration] });

      await expect(githubService.getInstallationClient(integration.installation_id))
        .rejects.toThrow('GitHub token has expired');
    });

    it('should throw when device token is expired and refresh fails', async () => {
      const integration = makeIntegration();

      dbMock.mockResolvedValueOnce({ rows: [integration] });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          error: 'bad_refresh_token',
          error_description: 'Invalid refresh token',
        }),
      });

      await expect(githubService.getInstallationClient(integration.installation_id))
        .rejects.toThrow('GitHub token has expired');
    });

    it('should not attempt refresh when device token is still valid', async () => {
      const integration = makeIntegration({
        token_expires_at: new Date(Date.now() + 4 * 3600_000).toISOString(), // 4h remaining
      });

      dbMock.mockResolvedValueOnce({ rows: [integration] });

      const octokit = await githubService.getInstallationClient(integration.installation_id);

      expect(octokit).toBeDefined();
      expect(mockFetch).not.toHaveBeenCalled(); // No refresh attempted
    });

    it('prefers app auth for real installations even when a copied user token looks expired', async () => {
      const integration = makeIntegration({
        installation_id: 12345,
        refresh_token_encrypted: null,
      });
      const installationOctokit = { request: vi.fn() };

      process.env.GITHUB_APP_ID = 'app-id';
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = '/tmp/github-app.pem';

      dbMock.mockResolvedValueOnce({ rows: [integration] });
      vi.spyOn(githubService, 'initializeApp').mockImplementation(async () => {
        githubService.initialized = true;
        githubService.app = {
          getInstallationOctokit: vi.fn().mockResolvedValue(installationOctokit),
        };
      });

      const octokit = await githubService.getInstallationClient(integration.installation_id);

      expect(octokit).toBe(installationOctokit);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(githubService.app.getInstallationOctokit).toHaveBeenCalledWith(integration.installation_id);
    });
  });

  describe('getInstallationById', () => {
    it('should ignore inactive installations', async () => {
      dbMock.mockResolvedValueOnce({ rows: [] });

      const result = await githubService.getInstallationById(12345);

      expect(result).toBeNull();
      expect(dbMock).toHaveBeenCalledWith(
        'SELECT * FROM github_integrations WHERE installation_id = $1 AND is_active = TRUE',
        [12345]
      );
    });
  });

  describe('getCompareFiles', () => {
    it('paginates compare files and preserves commit count from the first page', async () => {
      const request = vi.fn()
        .mockResolvedValueOnce({
          data: {
            commits: [{ sha: 'c1' }, { sha: 'c2' }],
            files: Array.from({ length: 100 }, (_, index) => ({
              filename: `src/file-${index}.ts`,
              status: 'modified',
              additions: 1,
              deletions: 0,
              patch: null,
              previous_filename: null,
            })),
          },
        })
        .mockResolvedValueOnce({
          data: {
            commits: [],
            files: [
              {
                filename: 'src/file-100.ts',
                status: 'modified',
                additions: 2,
                deletions: 1,
                patch: null,
                previous_filename: null,
              },
            ],
          },
        });
      vi.spyOn(githubService, 'getInstallationClient').mockResolvedValue({ request });

      const result = await githubService.getCompareFiles(123, 'atlas', 'engine', 'base', 'head');

      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[0][1]).toMatchObject({ page: 1, per_page: 100 });
      expect(request.mock.calls[1][1]).toMatchObject({ page: 2, per_page: 100 });
      expect(result.fileCount).toBe(101);
      expect(result.commitCount).toBe(2);
      expect(result.totalAdditions).toBe(102);
      expect(result.totalDeletions).toBe(1);
      expect(result.truncated).toBe(false);
    });

    it('stops paginating compare files after the defensive page cap', async () => {
      const request = vi.fn().mockResolvedValue({
        data: {
          commits: [{ sha: 'c1' }],
          files: Array.from({ length: 100 }, (_, index) => ({
            filename: `src/file-${index}.ts`,
            status: 'modified',
            additions: 1,
            deletions: 0,
            patch: null,
            previous_filename: null,
          })),
        },
      });
      vi.spyOn(githubService, 'getInstallationClient').mockResolvedValue({ request });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await githubService.getCompareFiles(123, 'atlas', 'engine', 'base', 'head');

      expect(request).toHaveBeenCalledTimes(20);
      expect(result.fileCount).toBe(2000);
      expect(result.truncated).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith('[GitHub] Compare pagination hit cap for atlas/engine base...head');
    });
  });

  // ─── getDecryptedToken() auto-refresh ────────────────────────────

  describe('getDecryptedToken - auto-refresh', () => {
    it('should auto-refresh and return new token when device token is expired', async () => {
      const integration = makeIntegration();

      // getInstallationById
      dbMock.mockResolvedValueOnce({ rows: [integration] });

      // refreshDeviceToken fetch
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          access_token: 'refreshed-token-2',
          refresh_token: 'rotated-refresh-2',
          expires_in: 28800,
          refresh_token_expires_in: 15811200,
        }),
      });

      // refreshDeviceToken DB updates
      dbMock
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [makeIntegration({
            installation_id: integration.installation_id,
            token_expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
            access_token_encrypted: 'encrypted:refreshed-token-2',
            user_access_token_encrypted: 'encrypted:refreshed-token-2',
          })],
        });

      const token = await githubService.getDecryptedToken(integration.installation_id);

      expect(token).toBe('refreshed-token-2');
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('should return existing token when not expired', async () => {
      const integration = makeIntegration({
        token_expires_at: new Date(Date.now() + 4 * 3600_000).toISOString(),
      });

      dbMock.mockResolvedValueOnce({ rows: [integration] });

      const token = await githubService.getDecryptedToken(integration.installation_id);

      expect(token).toBe('old-access-token');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns the existing installation token when a real installation token is still valid', async () => {
      const integration = makeIntegration({
        installation_id: 45678,
        refresh_token_encrypted: null,
        token_expires_at: new Date(Date.now() + 4 * 3600_000).toISOString(),
      });

      process.env.GITHUB_APP_ID = 'app-id';
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = '/tmp/github-app.pem';

      dbMock.mockResolvedValueOnce({ rows: [integration] });
      vi.spyOn(githubService, 'initializeApp').mockImplementation(async () => {
        githubService.initialized = true;
        githubService.app = {
          getInstallationOctokit: vi.fn(),
        };
      });
      const refreshSpy = vi.spyOn(githubService, 'refreshInstallationToken');

      const token = await githubService.getDecryptedToken(integration.installation_id);

      expect(token).toBe('old-access-token');
      expect(refreshSpy).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should throw when expired and refresh fails', async () => {
      const integration = makeIntegration();

      dbMock.mockResolvedValueOnce({ rows: [integration] });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({ error: 'bad_refresh_token' }),
      });

      await expect(githubService.getDecryptedToken(integration.installation_id))
        .rejects.toThrow('GitHub token has expired');
    });

    it('should throw when expired and no refresh token exists', async () => {
      const integration = makeIntegration({ refresh_token_encrypted: null });

      dbMock.mockResolvedValueOnce({ rows: [integration] });

      await expect(githubService.getDecryptedToken(integration.installation_id))
        .rejects.toThrow('GitHub token has expired');
    });

    it('refreshes an installation token for real installations even when a user token is present', async () => {
      const integration = makeIntegration({
        installation_id: 45678,
        refresh_token_encrypted: null,
      });

      process.env.GITHUB_APP_ID = 'app-id';
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = '/tmp/github-app.pem';

      dbMock.mockResolvedValueOnce({ rows: [integration] });
      vi.spyOn(githubService, 'initializeApp').mockImplementation(async () => {
        githubService.initialized = true;
        githubService.app = {
          getInstallationOctokit: vi.fn(),
        };
      });
      vi.spyOn(githubService, 'refreshInstallationToken').mockResolvedValue({
        token: 'installation-token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });

      const token = await githubService.getDecryptedToken(integration.installation_id);

      expect(token).toBe('installation-token');
      expect(githubService.refreshInstallationToken).toHaveBeenCalledWith(integration.installation_id);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('resolveUserInstallationSyncAuth', () => {
    it('skips expired non-refreshable rows and uses a refreshable candidate instead', async () => {
      const expiredOrgInstall = makeIntegration({
        installation_id: 111,
        refresh_token_encrypted: null,
        token_expires_at: new Date(Date.now() - 3600_000).toISOString(),
        created_at: '2026-03-09T12:00:00.000Z',
      });
      const deviceIntegration = makeIntegration({
        installation_id: -1707000000001,
        created_at: '2026-03-09T11:00:00.000Z',
      });

      dbMock
        .mockResolvedValueOnce({ rows: [expiredOrgInstall, deviceIntegration] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [makeIntegration({
            installation_id: deviceIntegration.installation_id,
            token_expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
            access_token_encrypted: 'encrypted:refreshed-sync-token',
            user_access_token_encrypted: 'encrypted:refreshed-sync-token',
          })],
        });
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          access_token: 'refreshed-sync-token',
          refresh_token: 'rotated-refresh',
          expires_in: 28800,
          refresh_token_expires_in: 15811200,
        }),
      });

      const resolved = await githubService.resolveUserInstallationSyncAuth('user-1');

      expect(resolved).toEqual(expect.objectContaining({
        integration: expect.objectContaining({ installation_id: deviceIntegration.installation_id }),
        token: 'refreshed-sync-token',
      }));
    });

    it('falls back from an expired org row to a refreshable sibling auth row', async () => {
      const expiredOrgInstall = makeIntegration({
        installation_id: 222,
        refresh_token_encrypted: null,
        token_expires_at: new Date(Date.now() - 3600_000).toISOString(),
        created_at: '2026-03-09T12:00:00.000Z',
      });
      const deviceIntegration = makeIntegration({
        installation_id: -1707000000001,
        created_at: '2026-03-09T11:00:00.000Z',
      });

      dbMock
        .mockResolvedValueOnce({ rows: [expiredOrgInstall] }) // getInstallationById(org)
        .mockResolvedValueOnce({ rows: [expiredOrgInstall, deviceIntegration] }) // sibling resolution
        .mockResolvedValueOnce({ rows: [] }) // refresh current row
        .mockResolvedValueOnce({ rows: [] }) // sync sibling rows
        .mockResolvedValueOnce({
          rows: [makeIntegration({
            installation_id: deviceIntegration.installation_id,
            token_expires_at: new Date(Date.now() + 8 * 3600_000).toISOString(),
            access_token_encrypted: 'encrypted:refreshed-org-fallback-token',
            user_access_token_encrypted: 'encrypted:refreshed-org-fallback-token',
          })],
        });

      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          access_token: 'refreshed-org-fallback-token',
          refresh_token: 'rotated-refresh',
          expires_in: 28800,
          refresh_token_expires_in: 15811200,
        }),
      });

      const octokit = await githubService.getInstallationClient(expiredOrgInstall.installation_id);

      expect(octokit).toBeDefined();
      expect(typeof octokit.request).toBe('function');
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });

  describe('getUserRepositories', () => {
    it('uses the user installations endpoint when auth falls back to a user token for a real installation', async () => {
      const request = vi.fn().mockResolvedValue({
        data: {
          repositories: [{
            id: 1,
            name: 'atlas',
            full_name: 'AtlasAIEngine/atlas',
            owner: { login: 'AtlasAIEngine' },
            private: true,
            description: 'Atlas repo',
            clone_url: 'https://github.com/AtlasAIEngine/atlas.git',
            default_branch: 'main',
            updated_at: '2026-03-09T00:00:00.000Z',
            language: 'TypeScript',
            size: 123,
          }],
        },
      });

      vi.spyOn(githubService, 'getInstallationClientContext').mockResolvedValue({
        integration: { installation_id: 12345 },
        octokit: { request },
        authMode: 'user',
      });
      githubService.app = { getInstallationOctokit: vi.fn() };

      const repositories = await githubService.getUserRepositories(12345, { page: 2, per_page: 50 });

      expect(request).toHaveBeenCalledWith(
        'GET /user/installations/{installation_id}/repositories',
        expect.objectContaining({
          installation_id: 12345,
          page: 2,
          per_page: 50,
        })
      );
      expect(repositories).toEqual([
        expect.objectContaining({
          fullName: 'AtlasAIEngine/atlas',
          owner: 'AtlasAIEngine',
        }),
      ]);
    });
  });

  describe('submitPullRequestReview', () => {
    it('passes multi-line review coordinates through to GitHub', async () => {
      const request = vi.fn().mockResolvedValue({
        data: {
          id: 9010,
          html_url: 'https://github.com/AtlasAIEngine/AtlasEngineMVPClaude/pull/65#pullrequestreview-9010',
          state: 'COMMENTED',
          submitted_at: '2026-03-09T18:10:00.000Z',
        },
      });

      vi.spyOn(githubService, 'getInstallationClientContext').mockResolvedValue({
        integration: makeIntegration({
          installation_id: 12345,
        }),
        octokit: { request },
        authMode: 'installation',
      });

      await githubService.submitPullRequestReview(
        12345,
        'AtlasAIEngine',
        'AtlasEngineMVPClaude',
        65,
        {
          event: 'COMMENT',
          body: 'Atlas review body',
          comments: [
            {
              path: 'src/example.ts',
              line: 13,
              startLine: 12,
              side: 'RIGHT',
              startSide: 'RIGHT',
              body: '```suggestion\nupdated();\n```',
            },
          ],
        },
      );

      expect(request).toHaveBeenCalledWith(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        expect.objectContaining({
          owner: 'AtlasAIEngine',
          repo: 'AtlasEngineMVPClaude',
          pull_number: 65,
          event: 'COMMENT',
          comments: [
            expect.objectContaining({
              path: 'src/example.ts',
              line: 13,
              side: 'RIGHT',
              start_line: 12,
              start_side: 'RIGHT',
              body: '```suggestion\nupdated();\n```',
            }),
          ],
        }),
      );
    });

    it('prefers a user token when creating PR reviews', async () => {
      const installationRequest = vi.fn();
      const userRequest = vi.fn().mockResolvedValue({
        data: {
          id: 9001,
          html_url: 'https://github.com/AtlasAIEngine/AtlasEngineMVPClaude/pull/65#pullrequestreview-9001',
          state: 'COMMENTED',
          submitted_at: '2026-03-09T18:15:00.000Z',
        },
      });

      vi.spyOn(githubService, 'getInstallationClientContext').mockResolvedValue({
        integration: makeIntegration({
          installation_id: 12345,
        }),
        octokit: { request: installationRequest },
        authMode: 'installation',
      });
      vi.spyOn(githubService, 'getUserScopedAuthContext').mockResolvedValue({
        integration: makeIntegration({ installation_id: 12345 }),
        token: 'user-token-1',
      });
      const createAuthClientSpy = vi.spyOn(githubService, 'createAuthClient').mockReturnValue({
        request: userRequest,
      });

      const result = await githubService.submitPullRequestReview(
        12345,
        'AtlasAIEngine',
        'AtlasEngineMVPClaude',
        65,
        {
          event: 'COMMENT',
          body: 'Atlas review body',
        },
      );

      expect(installationRequest).not.toHaveBeenCalled();
      expect(githubService.getUserScopedAuthContext).toHaveBeenCalled();
      expect(createAuthClientSpy).toHaveBeenCalledWith('user-token-1');
      expect(userRequest).toHaveBeenCalledWith(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        expect.objectContaining({
          owner: 'AtlasAIEngine',
          repo: 'AtlasEngineMVPClaude',
          pull_number: 65,
          event: 'COMMENT',
        }),
      );
      expect(result).toEqual(expect.objectContaining({
        event: 'COMMENT',
        githubReviewId: '9001',
        state: 'COMMENTED',
      }));
    });

    it('falls back via the user sync auth when the installation row has no stored user token', async () => {
      const installationRequest = vi.fn()
        .mockRejectedValueOnce({
          status: 403,
          message: 'Resource not accessible by integration',
        });
      const fallbackRequest = vi.fn().mockResolvedValue({
        data: {
          id: 9002,
          html_url: 'https://github.com/AtlasAIEngine/AtlasEngineMVPClaude/pull/65#pullrequestreview-9002',
          state: 'COMMENTED',
          submitted_at: '2026-03-09T18:18:00.000Z',
        },
      });

      vi.spyOn(githubService, 'getInstallationClientContext').mockResolvedValue({
        integration: makeIntegration({
          installation_id: 12345,
          user_id: 'user-1',
          access_token_encrypted: null,
          user_access_token_encrypted: null,
          refresh_token_encrypted: null,
        }),
        octokit: { request: installationRequest },
        authMode: 'installation',
      });
      vi.spyOn(githubService, 'resolveUserInstallationSyncAuth').mockResolvedValue({
        integration: makeIntegration({
          installation_id: -1707000000001,
          user_id: 'user-1',
        }),
        token: 'user-token-from-device-flow',
      });
      const createAuthClientSpy = vi.spyOn(githubService, 'createAuthClient').mockReturnValue({
        request: fallbackRequest,
      });

      const result = await githubService.submitPullRequestReview(
        12345,
        'AtlasAIEngine',
        'AtlasEngineMVPClaude',
        65,
        {
          event: 'COMMENT',
          body: 'Atlas review body',
        },
      );

      expect(githubService.resolveUserInstallationSyncAuth).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          excludeInstallationIds: [12345],
        })
      );
      expect(createAuthClientSpy).toHaveBeenCalledWith('user-token-from-device-flow');
      expect(fallbackRequest).toHaveBeenCalledWith(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        expect.objectContaining({
          owner: 'AtlasAIEngine',
          repo: 'AtlasEngineMVPClaude',
          pull_number: 65,
          event: 'COMMENT',
        }),
      );
      expect(result).toEqual(expect.objectContaining({
        event: 'COMMENT',
        githubReviewId: '9002',
        state: 'COMMENTED',
      }));
    });

    it('falls back to gh CLI in desktop mode when both GitHub API auth paths are blocked', async () => {
      const installationRequest = vi.fn()
        .mockRejectedValueOnce({
          status: 403,
          message: 'Resource not accessible by integration',
        });
      const fallbackRequest = vi.fn()
        .mockRejectedValueOnce({
          status: 403,
          message: 'Resource not accessible by integration',
        });
      const ghCliSpy = vi.spyOn(githubService, 'submitPullRequestReviewWithGhCli').mockResolvedValue({
        id: 9003,
        html_url: 'https://github.com/AtlasAIEngine/AtlasEngineMVPClaude/pull/65#pullrequestreview-9003',
        state: 'COMMENTED',
        submitted_at: '2026-03-09T18:20:00.000Z',
      });

      vi.spyOn(githubService, 'getInstallationClientContext').mockResolvedValue({
        integration: makeIntegration({
          installation_id: 12345,
        }),
        octokit: { request: installationRequest },
        authMode: 'installation',
      });
      vi.spyOn(githubService, 'getUserScopedAuthContext').mockResolvedValue({
        integration: makeIntegration({ installation_id: 12345 }),
        token: 'user-token-1',
      });
      vi.spyOn(githubService, 'createAuthClient').mockReturnValue({
        request: fallbackRequest,
      });

      const result = await githubService.submitPullRequestReview(
        12345,
        'AtlasAIEngine',
        'AtlasEngineMVPClaude',
        65,
        {
          event: 'COMMENT',
          body: 'Atlas review body',
        },
      );

      expect(ghCliSpy).toHaveBeenCalledWith(
        'AtlasAIEngine',
        'AtlasEngineMVPClaude',
        65,
        expect.objectContaining({
          event: 'COMMENT',
          body: 'Atlas review body',
        }),
      );
      expect(result).toEqual(expect.objectContaining({
        event: 'COMMENT',
        githubReviewId: '9003',
        state: 'COMMENTED',
      }));
    });

    it('falls back to gh CLI in desktop mode when direct user auth is resource-blocked', async () => {
      const userRequest = vi.fn()
        .mockRejectedValueOnce({
          status: 403,
          message: 'Resource not accessible by integration',
        });
      const ghCliSpy = vi.spyOn(githubService, 'submitPullRequestReviewWithGhCli').mockResolvedValue({
        id: 9004,
        html_url: 'https://github.com/AtlasAIEngine/AtlasEngineMVPClaude/pull/65#pullrequestreview-9004',
        state: 'COMMENTED',
        submitted_at: '2026-03-09T18:22:00.000Z',
      });

      vi.spyOn(githubService, 'getInstallationClientContext').mockResolvedValue({
        integration: makeIntegration({
          installation_id: 12345,
        }),
        octokit: { request: userRequest },
        authMode: 'user',
      });

      const result = await githubService.submitPullRequestReview(
        12345,
        'AtlasAIEngine',
        'AtlasEngineMVPClaude',
        65,
        {
          event: 'COMMENT',
          body: 'Atlas review body',
        },
      );

      expect(ghCliSpy).toHaveBeenCalledWith(
        'AtlasAIEngine',
        'AtlasEngineMVPClaude',
        65,
        expect.objectContaining({
          event: 'COMMENT',
          body: 'Atlas review body',
        }),
      );
      expect(result).toEqual(expect.objectContaining({
        event: 'COMMENT',
        githubReviewId: '9004',
        state: 'COMMENTED',
      }));
    });

    it('returns an Atlas-specific error in browser mode when PR review publish is integration-blocked', async () => {
      process.env = {
        ...originalEnv,
        ATLAS_DESKTOP_MODE: 'false',
        GITHUB_APP_CLIENT_ID: 'test-client-id',
        GITHUB_APP_CLIENT_SECRET: 'test-client-secret',
        ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      };
      vi.resetModules();

      const module = await import('../githubService.js');
      const browserGithubService = module.default;

      vi.spyOn(browserGithubService, 'getInstallationClientContext').mockResolvedValue({
        integration: makeIntegration({
          installation_id: 12345,
          user_access_token_encrypted: null,
          access_token_encrypted: null,
          refresh_token_encrypted: null,
        }),
        octokit: {
          request: vi.fn().mockRejectedValueOnce({
            status: 403,
            message: 'Resource not accessible by integration',
          }),
        },
        authMode: 'installation',
      });
      vi.spyOn(browserGithubService, 'resolveUserReviewFallbackToken').mockResolvedValue(null);

      await expect(browserGithubService.submitPullRequestReview(
        12345,
        'AtlasAIEngine',
        'AtlasEngineMVPClaude',
        65,
        {
          event: 'COMMENT',
          body: 'Atlas review body',
        },
      )).rejects.toThrow(
        'GitHub App auth cannot submit this PR review here. Reconnect your personal GitHub account in Atlas, or use the desktop app where gh CLI fallback is available.'
      );
    });
  });
});

// ─── isTokenExpired() edge cases ────────────────────────────────────

describe('isTokenExpired - buffer window', () => {
  let githubService;

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv, ATLAS_DESKTOP_MODE: 'true' };
    const module = await import('../githubService.js');
    githubService = module.default;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should consider token expired when less than 5 min remaining', () => {
    const fourMinFromNow = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    expect(githubService.isTokenExpired(fourMinFromNow)).toBe(true);
  });

  it('should consider token valid when more than 5 min remaining', () => {
    const sixMinFromNow = new Date(Date.now() + 6 * 60 * 1000).toISOString();
    expect(githubService.isTokenExpired(sixMinFromNow)).toBe(false);
  });

  it('should consider token expired when already past', () => {
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    expect(githubService.isTokenExpired(oneHourAgo)).toBe(true);
  });
});
