import { afterEach, describe, expect, it, vi } from 'vitest';
import gitService from '../gitService.js';

describe('gitService auth helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strips embedded credentials from https remotes before persisting them', () => {
    expect(
      gitService.sanitizeRemoteUrl('https://x-access-token:secret@github.com/acme/repo.git')
    ).toBe('https://github.com/acme/repo.git');

    expect(
      gitService.sanitizeRemoteUrl('https://alice:secret@example.com/org/repo.git')
    ).toBe('https://example.com/org/repo.git');

    expect(
      gitService.sanitizeRemoteUrl('git@github.com:acme/repo.git')
    ).toBe('git@github.com:acme/repo.git');
  });

  it('injects GitHub auth through per-command config instead of the remote URL', () => {
    const args = gitService.buildGitHubAuthConfigArgs('token-123');

    expect(args).toEqual([
      '-c', 'credential.helper=',
      '-c', 'credential.interactive=false',
      '-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from('x-access-token:token-123', 'utf8').toString('base64')}`,
    ]);
  });

  it('reads the remote default branch from local origin HEAD without calling git remote show', async () => {
    const raw = vi.fn(async (args) => {
      expect(args).toEqual(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      return 'origin/main\n';
    });

    vi.spyOn(gitService, 'getNonInteractiveGitInstance').mockReturnValue({ raw });

    await expect(gitService.getRemoteDefaultBranch('/tmp/project')).resolves.toBe('main');
    expect(raw).toHaveBeenCalledTimes(1);
  });
});
