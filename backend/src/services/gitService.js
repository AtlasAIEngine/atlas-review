/**
 * Git Service
 * Handles local Git operations using simple-git
 *
 * Features:
 * - Repository cloning with authentication
 * - Commit, push, pull operations
 * - Branch management
 * - Conflict detection
 * - Git status and history
 *
 * Dependencies:
 * - simple-git: High-level Git operations wrapper
 */

import simpleGit from 'simple-git';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';

function parseTimeoutMs(rawValue, fallback, { min = 1, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(rawValue);
  const normalized = Number.isFinite(parsed) ? Math.trunc(parsed) : Math.trunc(fallback);
  return Math.min(max, Math.max(min, normalized));
}

const DEFAULT_GIT_TIMEOUT_MS = parseTimeoutMs(
  process.env.ATLAS_GIT_TIMEOUT_MS,
  120000,
  { min: 30000 }
);
const DEFAULT_WALKTHROUGH_DIFF_MAX_CHARS = 60_000;

function parseBoundedInteger(rawValue, fallback, { min = 1, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(rawValue);
  const normalized = Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : Math.trunc(fallback);
  return Math.min(max, Math.max(min, normalized));
}

// The SHA of an empty git tree — used as the merge-base for root commits.
const GIT_EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Build a git diff range string. Uses two-dot for the empty tree (which is
 * a tree object, not a commit, so three-dot fails) and three-dot otherwise.
 */
function buildDiffRange(baseSha, headRef) {
  if (baseSha === GIT_EMPTY_TREE_SHA) {
    return `${baseSha}..${headRef || 'HEAD'}`;
  }
  return `${baseSha}...${headRef || 'HEAD'}`;
}

class GitService {
  async runGitCommandWithOutputLimit(projectPath, args, options = {}) {
    const maxBytes = parseBoundedInteger(options.maxBytes, DEFAULT_WALKTHROUGH_DIFF_MAX_CHARS, {
      min: 1024,
      max: 5_000_000,
    });
    const timeoutMs = parseTimeoutMs(options.timeoutMs, DEFAULT_GIT_TIMEOUT_MS, { min: 5000 });

    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: projectPath,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          GIT_OPTIONAL_LOCKS: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks = [];
      let stdoutBytes = 0;
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let killTimer = null;

      const stopChild = () => {
        if (child.killed) return;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process already exited.
          }
        }, 1000);
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        stopChild();
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        if (stdoutBytes >= maxBytes) {
          truncated = true;
          stopChild();
          return;
        }

        const remaining = maxBytes - stdoutBytes;
        if (chunk.length > remaining) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes = maxBytes;
          truncated = true;
          stopChild();
          return;
        }

        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      });

      child.stderr.on('data', (chunk) => {
        if (stderr.length < 16_384) {
          stderr += chunk.toString('utf8').slice(0, 16_384 - stderr.length);
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);

        const output = Buffer.concat(stdoutChunks).toString('utf8');
        if (timedOut) {
          reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
          return;
        }
        if (truncated) {
          resolve({
            output: `${output}\n\n... (diff truncated before walkthrough generation)`,
            truncated: true,
          });
          return;
        }
        if (code === 0) {
          resolve({ output, truncated: false });
          return;
        }

        const message = stderr.trim() || `git ${args.join(' ')} failed with ${signal || `exit code ${code}`}`;
        reject(new Error(message));
      });
    });
  }

  sanitizeRemoteUrl(remoteUrl) {
    const raw = String(remoteUrl || '').trim();
    if (!raw) return raw;

    try {
      const parsed = new URL(raw);
      if (!/^https?:$/i.test(parsed.protocol)) {
        return raw;
      }
      if (!parsed.username && !parsed.password) {
        return raw;
      }
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    } catch {
      return raw.replace(/^(https?:\/\/)[^/@]+@/i, '$1');
    }
  }

  buildGitHubAuthConfigArgs(token) {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) return [];

    const basicAuth = Buffer.from(`x-access-token:${normalizedToken}`, 'utf8').toString('base64');
    return [
      '-c', 'credential.helper=',
      '-c', 'credential.interactive=false',
      '-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicAuth}`,
    ];
  }

  getNonInteractiveGitInstance(projectPath, options = {}) {
    const git = this.getGitInstance(projectPath, options);
    if (typeof git?.env === 'function') {
      git.env('GIT_TERMINAL_PROMPT', '0');
      git.env('GCM_INTERACTIVE', 'never');
    }
    return git;
  }

  async runAuthenticatedRemoteCommand(projectPath, args, token, options = {}) {
    const git = this.getNonInteractiveGitInstance(projectPath, options);
    const authArgs = this.buildGitHubAuthConfigArgs(token);
    return git.raw([...authArgs, ...args]);
  }

  /**
   * PR helper refs/branches created locally during debugging should not be
   * treated as canonical base branches for review diffs.
   */
  isSyntheticBaseBranchCandidate(branchName) {
    const name = String(branchName || '').trim();
    if (!name) return true;
    return /^pr\d+-(head|merge)$/i.test(name)
      || /^pull\/\d+\/(head|merge)$/i.test(name);
  }

  /**
   * Initialize simple-git instance for a project
   *
   * @param {string} projectPath - Absolute path to project directory
   * @returns {Object} simple-git instance
   */
  getGitInstance(projectPath, options = {}) {
    const requestedTimeout = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : DEFAULT_GIT_TIMEOUT_MS;
    return simpleGit(projectPath, { timeout: { block: timeoutMs } });
  }

  /**
   * Clone a repository from GitHub
   *
   * @param {string} repoUrl - Repository clone URL (HTTPS)
   * @param {string} projectPath - Local path to clone into
   * @param {Object} options - Clone options
   * @param {string} options.branch - Branch to clone (default: default branch)
   * @param {number} options.depth - Clone depth for shallow clone
   * @param {string} options.token - GitHub access token for authentication
   * @returns {Promise<Object>} Clone result
   */
  async cloneRepository(repoUrl, projectPath, options = {}) {
    try {
      const { branch, depth, token } = options;

      console.log(`📥 Cloning repository to ${projectPath}...`);

      // Ensure parent directory exists
      const parentDir = path.dirname(projectPath);
      await fs.mkdir(parentDir, { recursive: true });

      // Build clone options
      const cloneOptions = [];

      if (branch) {
        cloneOptions.push('--branch', branch);
      }

      if (depth) {
        cloneOptions.push('--depth', depth.toString());
      }

      // Add single-branch for faster cloning
      cloneOptions.push('--single-branch');

      // Inject token into URL for authentication if provided
      let authenticatedUrl = repoUrl;
      if (token) {
        // Convert https://github.com/owner/repo.git to https://x-access-token:TOKEN@github.com/owner/repo.git
        authenticatedUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);
      }

      const git = simpleGit();

      // Clone repository
      await git.clone(authenticatedUrl, projectPath, cloneOptions);

      // Never persist credential-bearing URLs into local git config.
      await this.setRemoteUrl(projectPath, repoUrl, null, 'origin');

      console.log(`✅ Repository cloned successfully to ${projectPath}`);

      // Get initial commit info
      const gitInstance = this.getGitInstance(projectPath);
      const log = await gitInstance.log({ maxCount: 1 });
      const status = await gitInstance.status();

      return {
        success: true,
        path: projectPath,
        branch: status.current,
        latestCommit: log.latest ? {
          hash: log.latest.hash,
          message: log.latest.message,
          author: log.latest.author_name,
          date: log.latest.date,
        } : null,
      };
    } catch (error) {
      console.error('Failed to clone repository:', error.message);
      throw new Error(`Git clone failed: ${error.message}`);
    }
  }

  /**
   * Initialize a new Git repository
   *
   * @param {string} projectPath - Path to initialize Git in
   * @returns {Promise<boolean>} Success status
   */
  async initRepository(projectPath) {
    try {
      const git = this.getGitInstance(projectPath);
      await git.init();

      console.log(`✅ Initialized Git repository at ${projectPath}`);

      return true;
    } catch (error) {
      console.error('Failed to initialize Git repository:', error.message);
      throw error;
    }
  }

  /**
   * Get Git status for a project
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<Object>} Git status
   */
  async getStatus(projectPath) {
    try {
      const git = this.getGitInstance(projectPath);
      const status = await git.status();

      return {
        branch: status.current,
        ahead: status.ahead,
        behind: status.behind,
        modified: status.modified,
        created: status.created,
        deleted: status.deleted,
        renamed: status.renamed,
        staged: status.staged,
        conflicted: status.conflicted,
        notAdded: status.not_added, // Untracked files (new files not yet staged)
        isClean: status.isClean(),
      };
    } catch (error) {
      console.error('Failed to get Git status:', error.message);
      throw error;
    }
  }

  /**
   * Stage and commit changes
   *
   * @param {string} projectPath - Project directory path
   * @param {string} message - Commit message
   * @param {Array<string>} files - Files to commit (default: all)
   * @returns {Promise<Object>} Commit result
   */
  async commitChanges(projectPath, message, files = ['.']) {
    try {
      const git = this.getGitInstance(projectPath);

      // Stage the specified files (required for untracked/new files)
      await git.add(files);

      let hasHead = true;
      try {
        await git.raw(['rev-parse', '--verify', 'HEAD']);
      } catch {
        hasHead = false;
      }

      // For the initial commit there is no HEAD yet. Use a raw path-scoped
      // commit so we still honor `files` and avoid sweeping in unrelated
      // staged changes.
      let result;
      if (hasHead) {
        result = await git.commit(message, files, { '--only': null });
      } else {
        await git.raw(['commit', '-m', message, '--only', '--', ...files]);
        const commit = (await git.raw(['rev-parse', 'HEAD'])).trim();
        const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        result = {
          commit,
          branch,
          summary: {
            changes: 0,
            insertions: 0,
            deletions: 0,
          },
        };
      }

      console.log(`✅ Committed changes: ${result.commit}`);

      return {
        success: true,
        commit: result.commit,
        summary: result.summary,
        branch: result.branch,
      };
    } catch (error) {
      console.error('Failed to commit changes:', error.message);
      throw error;
    }
  }

  /**
   * Push changes to remote
   *
   * @param {string} projectPath - Project directory path
   * @param {string} remote - Remote name (default: origin)
   * @param {string} branch - Branch name (default: current branch)
   * @param {Object} options - Push options
   * @returns {Promise<Object>} Push result
   */
  async push(projectPath, remote = 'origin', branch = null, options = {}) {
    try {
      const git = this.getNonInteractiveGitInstance(projectPath);
      const token = String(options?.token || '').trim() || null;

      // Get current branch if not specified
      if (!branch) {
        const status = await git.status();
        branch = status.current;
      }

      const pushOptions = [];

      if (options.force) {
        pushOptions.push('--force');
      }

      if (options.setUpstream) {
        pushOptions.push('--set-upstream');
      }

      if (token) {
        await this.runAuthenticatedRemoteCommand(
          projectPath,
          ['push', remote, branch, ...pushOptions],
          token
        );
      } else {
        await git.push(remote, branch, pushOptions);
      }

      console.log(`✅ Pushed changes to ${remote}/${branch}`);

      return {
        success: true,
        remote,
        branch,
      };
    } catch (error) {
      console.error('Failed to push changes:', error.message);
      throw error;
    }
  }

  /**
   * Pull changes from remote
   *
   * @param {string} projectPath - Project directory path
   * @param {string} remote - Remote name (default: origin)
   * @param {string} branch - Branch name (default: current branch)
   * @returns {Promise<Object>} Pull result
   */
  async pull(projectPath, remote = 'origin', branch = null, options = {}) {
    try {
      const git = this.getNonInteractiveGitInstance(projectPath);
      const token = String(options?.token || '').trim() || null;

      // Get current branch if not specified
      if (!branch) {
        const status = await git.status();
        branch = status.current;
      }

      let result;
      if (token) {
        await this.runAuthenticatedRemoteCommand(
          projectPath,
          ['pull', remote, branch],
          token
        );
        result = { summary: null, files: [], insertions: 0, deletions: 0 };
      } else {
        result = await git.pull(remote, branch);
      }

      console.log(`✅ Pulled changes from ${remote}/${branch}`);

      return {
        success: true,
        summary: result.summary,
        files: result.files,
        insertions: result.insertions,
        deletions: result.deletions,
      };
    } catch (error) {
      console.error('Failed to pull changes:', error.message);
      throw error;
    }
  }

  /**
   * Fetch from remote
   *
   * @param {string} projectPath - Project directory path
   * @param {string} remote - Remote name (default: origin)
   * @returns {Promise<boolean>} Success status
   */
  async fetch(projectPath, remote = 'origin') {
    try {
      const git = this.getNonInteractiveGitInstance(projectPath);
      await git.fetch(remote);

      console.log(`✅ Fetched from ${remote}`);

      return true;
    } catch (error) {
      console.error('Failed to fetch:', error.message);
      throw error;
    }
  }

  /**
   * Get current branch name
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<string>} Current branch name
   */
  async getCurrentBranch(projectPath) {
    try {
      const git = this.getGitInstance(projectPath);
      const status = await git.status();

      return status.current;
    } catch (error) {
      console.error('Failed to get current branch:', error.message);
      throw error;
    }
  }

  /**
   * List local branches
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<Array<{ name: string; current: boolean }>>} List of branches
   */
  async listBranches(projectPath) {
    try {
      const git = this.getGitInstance(projectPath);
      const [summary, rawRefs] = await Promise.all([
        git.branchLocal(),
        git.raw([
          'for-each-ref',
          'refs/heads',
          '--sort=-committerdate',
          '--format=%(refname:short)\t%(objectname)\t%(committerdate:iso-strict)',
        ]),
      ]);
      const current = summary.current;
      const byName = new Map();
      rawRefs
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          const [name, headSha, lastCommitAt] = line.split('\t');
          if (!name) return;
          byName.set(name, {
            name,
            current: name === current,
            headSha: headSha || null,
            lastCommitAt: lastCommitAt || null,
          });
        });

      const ordered = Array.from(byName.values());
      const seen = new Set(ordered.map(branch => branch.name));
      const missing = summary.all
        .filter(name => !seen.has(name))
        .map(name => ({
          name,
          current: name === current,
          headSha: null,
          lastCommitAt: null,
        }));

      return [...ordered, ...missing];
    } catch (error) {
      console.error('Failed to list branches:', error.message);
      throw error;
    }
  }

  /**
   * List git worktrees (excluding the main worktree and detached HEAD entries).
   *
   * @param {string} projectPath - Project directory path (main worktree)
   * @returns {Promise<Array<{ path: string; head: string; branch: string }>>} Secondary worktrees
   */
  async listWorktrees(projectPath) {
    try {
      const git = this.getGitInstance(projectPath);
      const raw = await git.raw(['worktree', 'list', '--porcelain']);
      return this.parseWorktreePorcelain(raw);
    } catch (error) {
      // Non-fatal — worktree listing may fail on old git or bare repos
      console.warn('Failed to list worktrees:', error.message);
      return [];
    }
  }

  /**
   * Parse `git worktree list --porcelain` output into structured entries.
   * Filters out the main worktree (first entry) and detached HEAD entries.
   *
   * @param {string} raw - Raw porcelain output
   * @returns {Array<{ path: string; head: string; branch: string }>}
   */
  parseWorktreePorcelain(raw) {
    if (!raw || typeof raw !== 'string') return [];

    const entries = [];
    let current = {};

    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) entries.push(current);
        current = { path: line.slice('worktree '.length).trim() };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        // branch refs/heads/feature-name → feature-name
        const ref = line.slice('branch '.length).trim();
        current.branch = ref.replace(/^refs\/heads\//, '');
      } else if (line.trim() === 'detached') {
        current.detached = true;
      }
    }
    if (current.path) entries.push(current);

    // Drop the first entry (main worktree) and any detached HEAD entries
    return entries
      .slice(1)
      .filter(e => e.branch && !e.detached)
      .map(({ path, head, branch }) => ({ path, head: head || '', branch }));
  }

  /**
   * Get commit history
   *
   * @param {string} projectPath - Project directory path
   * @param {number} limit - Number of commits to retrieve
   * @returns {Promise<Array>} Commit history
   */
  async getCommitHistory(projectPath, limit = 10) {
    try {
      const git = this.getGitInstance(projectPath);
      const log = await git.log({ maxCount: limit });

      return log.all.map(commit => ({
        hash: commit.hash,
        message: commit.message,
        author: commit.author_name,
        email: commit.author_email,
        date: commit.date,
        body: commit.body,
      }));
    } catch (error) {
      console.error('Failed to get commit history:', error.message);
      throw error;
    }
  }

  /**
   * Resolve commit messages for a bounded list of SHAs.
   *
   * @param {string} projectPath - Project directory path
   * @param {string[]} shas - Commit SHAs in preferred order
   * @returns {Promise<Array<{hash: string, message: string}>>}
   */
  async getCommitMessagesByShas(projectPath, shas = []) {
    const normalizedShas = Array.isArray(shas)
      ? shas
          .map((sha) => String(sha || '').trim())
          .filter((sha) => /^[0-9a-f]{7,40}$/i.test(sha))
      : [];
    if (normalizedShas.length === 0) return [];

    const git = this.getGitInstance(projectPath);
    const seen = new Set();
    const results = [];
    for (const sha of normalizedShas) {
      if (seen.has(sha.toLowerCase())) continue;
      seen.add(sha.toLowerCase());
      try {
        const output = await git.raw(['show', '-s', '--format=%H%n%s', sha]);
        const [hashLine, ...messageLines] = String(output || '').trim().split('\n');
        const hash = String(hashLine || '').trim();
        const message = messageLines.join(' ').trim();
        if (!hash || !message) continue;
        results.push({ hash, message });
      } catch {
        // Missing SHAs can happen for stale queue entries or shallow clones.
      }
    }
    return results;
  }

  /**
   * Get diff between commits
   *
   * @param {string} projectPath - Project directory path
   * @param {string} fromCommit - Start commit hash (optional)
   * @param {string} toCommit - End commit hash (optional, default: HEAD)
   * @returns {Promise<string>} Diff output
   */
  async getDiff(projectPath, fromCommit = null, toCommit = 'HEAD') {
    try {
      const git = this.getGitInstance(projectPath);

      let diff;
      if (fromCommit) {
        diff = await git.diff([`${fromCommit}..${toCommit}`]);
      } else {
        diff = await git.diff();
      }

      return diff;
    } catch (error) {
      console.error('Failed to get diff:', error.message);
      throw error;
    }
  }

  /**
   * Get a walkthrough-safe diff payload between two refs.
   *
   * The file manifest comes from `--numstat`, which stays compact even for
   * huge PRs. The patch excerpt is streamed with a hard byte cap so V8 never
   * has to allocate an unbounded diff string before prompt truncation.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} fromCommit - Start commit hash/ref
   * @param {string} toCommit - End commit hash/ref
   * @param {Object} options - Collection options
   * @returns {Promise<{diff: string, fileSummaries: Array<{path: string, additions: number, deletions: number}>, truncated: boolean}>}
   */
  async getDiffForWalkthrough(projectPath, fromCommit, toCommit = 'HEAD', options = {}) {
    try {
      const rangeMode = String(options.rangeMode || '').trim().toLowerCase();
      const useThreeDot = rangeMode === 'three-dot' || rangeMode === 'three_dot';
      const range = useThreeDot
        ? buildDiffRange(fromCommit, toCommit || 'HEAD')
        : `${fromCommit}..${toCommit || 'HEAD'}`;
      const omitDeletedFileBodies = options.omitDeletedFileBodies !== false;
      const maxChars = parseBoundedInteger(
        options.maxChars ?? process.env.ATLAS_WALKTHROUGH_DIFF_MAX_CHARS,
        DEFAULT_WALKTHROUGH_DIFF_MAX_CHARS,
        { min: 10_000, max: 1_000_000 }
      );

      const [stats, nameStatus] = useThreeDot
        ? await Promise.all([
            this.getThreeDotDiffStats(projectPath, fromCommit, toCommit),
            this.getThreeDotDiffNameStatus(projectPath, fromCommit, toCommit),
          ])
        : await Promise.all([
            this.getTwoDotDiffStats(projectPath, fromCommit, toCommit),
            this.getTwoDotDiffNameStatus(projectPath, fromCommit, toCommit),
          ]);
      const statusByPath = new Map();
      for (const entry of Array.isArray(nameStatus) ? nameStatus : []) {
        if (!entry?.path) continue;
        statusByPath.set(entry.path, {
          status: entry.status || null,
          oldPath: entry.oldPath || null,
        });
      }
      const fileSummaries = Array.isArray(stats?.files)
        ? stats.files.map((file) => {
            const meta = statusByPath.get(file.path) || {};
            return {
              ...file,
              ...(meta.status ? { status: meta.status } : {}),
              ...(meta.oldPath ? { oldPath: meta.oldPath } : {}),
            };
          })
        : [];
      // Deleted files still belong in the authoritative manifest, but their
      // removed bodies add little value to a structural walkthrough and can
      // dominate prompt budget on asset-heavy branches. Exclude D patches
      // from the excerpt while preserving D entries in fileSummaries.
      const diffFilterArgs = omitDeletedFileBodies ? ['--diff-filter=ACMRTUXB'] : [];
      const { output, truncated } = await this.runGitCommandWithOutputLimit(
        projectPath,
        ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', '--find-renames', ...diffFilterArgs, range],
        { maxBytes: maxChars, timeoutMs: options.timeoutMs }
      );

      return {
        diff: typeof output === 'string' ? output : '',
        fileSummaries,
        truncated: Boolean(truncated),
      };
    } catch (error) {
      console.error('Failed to get walkthrough diff:', error.message);
      throw error;
    }
  }

  /**
   * Get remote URL
   *
   * @param {string} projectPath - Project directory path
   * @param {string} remote - Remote name (default: origin)
   * @returns {Promise<string>} Remote URL
   */
  async getRemoteUrl(projectPath, remote = 'origin') {
    try {
      const git = this.getGitInstance(projectPath);
      const remotes = await git.getRemotes(true);

      const remoteObj = remotes.find(r => r.name === remote);

      if (!remoteObj) {
        throw new Error(`Remote '${remote}' not found`);
      }

      return remoteObj.refs.fetch;
    } catch (error) {
      console.error('Failed to get remote URL:', error.message);
      throw error;
    }
  }

  /**
   * Check if repository has conflicts
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<boolean>} True if conflicts exist
   */
  async hasConflicts(projectPath) {
    try {
      const status = await this.getStatus(projectPath);
      return status.conflicted.length > 0;
    } catch (error) {
      console.error('Failed to check conflicts:', error.message);
      throw error;
    }
  }

  /**
   * Get list of conflicted files
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<Array<string>>} Array of conflicted file paths
   */
  async getConflictFiles(projectPath) {
    try {
      const status = await this.getStatus(projectPath);
      return status.conflicted;
    } catch (error) {
      console.error('Failed to get conflict files:', error.message);
      throw error;
    }
  }

  /**
   * Set remote URL with authentication token
   *
   * @param {string} projectPath - Project directory path
   * @param {string} repoUrl - Repository HTTPS URL
   * @param {string} token - GitHub access token
   * @param {string} remote - Remote name (default: origin)
   * @returns {Promise<boolean>} Success status
   */
  async setRemoteUrl(projectPath, repoUrl, token, remote = 'origin') {
    try {
      const git = this.getGitInstance(projectPath);
      const sanitizedUrl = this.sanitizeRemoteUrl(repoUrl);

      // Set remote URL
      await git.remote(['set-url', remote, sanitizedUrl]);

      console.log(`✅ Set remote URL for ${remote}`);

      return true;
    } catch (error) {
      console.error('Failed to set remote URL:', error.message);
      throw error;
    }
  }

  /**
   * Check if directory is a Git repository
   * Checks if THIS specific directory has a .git folder, not if it's inside a git repo
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<boolean>} True if Git repository
   */
  async isGitRepository(projectPath) {
    try {
      const gitDir = path.join(projectPath, '.git');
      return existsSync(gitDir);
    } catch (error) {
      return false;
    }
  }

  /**
   * Parse .gitignore file
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<Array<string>>} Array of ignore patterns
   */
  async getIgnorePatterns(projectPath) {
    try {
      const gitignorePath = path.join(projectPath, '.gitignore');
      const patterns = [];

      const fileStream = createReadStream(gitignorePath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (trimmed && !trimmed.startsWith('#')) {
          patterns.push(trimmed);
        }
      }

      return patterns;
    } catch (error) {
      // .gitignore might not exist
      return [];
    }
  }

  /**
   * Get file blame information
   *
   * @param {string} projectPath - Project directory path
   * @param {string} filePath - Relative file path
   * @returns {Promise<Array>} Blame information per line
   */
  async getBlame(projectPath, filePath) {
    try {
      const git = this.getGitInstance(projectPath);
      const blame = await git.raw(['blame', '--line-porcelain', filePath]);

      // Parse blame output (simplified)
      const lines = blame.split('\n');
      const blameInfo = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.match(/^[0-9a-f]{40}/)) {
          blameInfo.push({
            commit: line.split(' ')[0],
            lineNumber: parseInt(line.split(' ')[2]),
          });
        }
      }

      return blameInfo;
    } catch (error) {
      console.error('Failed to get blame:', error.message);
      throw error;
    }
  }

  /**
   * Build bounded per-file risk context using local git history.
   *
   * @param {string} projectPath - Project directory path
   * @param {string[]} filePaths - Relative file paths
   * @param {Object} options - Collection options
   * @returns {Promise<Array<{filePath: string, lastAuthor: string|null, lastCommitDate: string|null, changeCount30d: number, distinctAuthors90d: number, hotspot: 'stable'|'active'|'hotspot'}>>}
   */
  async getFileRiskContext(projectPath, filePaths, options = {}) {
    const normalizedMaxFiles = Math.max(1, Math.trunc(Number(options.maxFiles) || 8));
    const normalizedRecentDays = Math.max(1, Math.trunc(Number(options.recentDays) || 30));
    const normalizedAuthorDays = Math.max(1, Math.trunc(Number(options.authorDays) || 90));
    const normalizedFilePaths = Array.from(new Set(
      (Array.isArray(filePaths) ? filePaths : [])
        .map((entry) => String(entry || '').trim().replace(/\\/g, '/'))
        .filter(Boolean)
    )).slice(0, normalizedMaxFiles);
    if (normalizedFilePaths.length === 0) {
      return [];
    }

    const git = this.getGitInstance(projectPath);
    const riskContext = [];

    for (const filePath of normalizedFilePaths) {
      let lastAuthor = null;
      let lastCommitDate = null;
      let changeCount30d = 0;
      let distinctAuthors90d = 0;

      try {
        const latestRaw = await git.raw(['log', '-1', '--format=%an|%ad', '--date=short', '--', filePath]);
        const latestLine = String(latestRaw || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
        if (latestLine) {
          const [author, date] = latestLine.split('|');
          lastAuthor = author ? author.trim() || null : null;
          lastCommitDate = date ? date.trim() || null : null;
        }
      } catch (error) {
        // Ignore per-file log failures to keep prompt-context collection resilient.
      }

      try {
        const commitsRaw = await git.raw([
          'log',
          `--since=${normalizedRecentDays}.days`,
          '--format=%H',
          '--',
          filePath,
        ]);
        changeCount30d = String(commitsRaw || '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .length;
      } catch (error) {
        changeCount30d = 0;
      }

      try {
        const authorsRaw = await git.raw([
          'log',
          `--since=${normalizedAuthorDays}.days`,
          '--format=%ae',
          '--',
          filePath,
        ]);
        distinctAuthors90d = new Set(
          String(authorsRaw || '')
            .split('\n')
            .map((line) => line.trim().toLowerCase())
            .filter(Boolean)
        ).size;
      } catch (error) {
        distinctAuthors90d = 0;
      }

      const hotspot = changeCount30d >= 8 || distinctAuthors90d >= 4
        ? 'hotspot'
        : changeCount30d >= 3 || distinctAuthors90d >= 2
          ? 'active'
          : 'stable';

      riskContext.push({
        filePath,
        lastAuthor,
        lastCommitDate,
        changeCount30d,
        distinctAuthors90d,
        hotspot,
      });
    }

    return riskContext;
  }

  // ============================================================================
  // BIDIRECTIONAL SYNC METHODS (Phase 2: Auto-Push)
  // ============================================================================

  /**
   * Stage, commit, and push changes to GitHub in one operation
   * Used by SyncWorker for auto-push functionality
   *
   * @param {string} projectPath - Project directory path
   * @param {string} message - Commit message
   * @param {Array<string>} files - Files to commit (default: all changed files)
   * @param {string} token - GitHub access token for authentication
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} branch - Branch to push to (default: current branch)
   * @returns {Promise<Object>} Result with commit SHA and push details
   */
  async commitAndPush(projectPath, message, files, token, owner, repo, branch = null) {
    try {
      const git = this.getNonInteractiveGitInstance(projectPath);

      // Get current branch if not specified
      if (!branch) {
        const status = await git.status();
        branch = status.current;
      }

      console.log(`🔄 Starting commit and push for ${owner}/${repo} on ${branch}...`);

      // Configure remote URL with token authentication
      const repoUrl = `https://github.com/${owner}/${repo}.git`;
      await this.setRemoteUrl(projectPath, repoUrl, token, 'origin');

      // Stage files
      if (files && files.length > 0) {
        console.log(`📦 Staging ${files.length} file(s)...`);
        await git.add(files);
      } else {
        console.log(`📦 Staging all changes...`);
        await git.add('.');
      }

      // Commit changes
      const commitResult = await git.commit(message);
      const commitSha = commitResult.commit;
      console.log(`✅ Committed changes: ${commitSha}`);

      // Push to remote
      await this.runAuthenticatedRemoteCommand(
        projectPath,
        ['push', 'origin', branch],
        token
      );
      console.log(`✅ Pushed to ${owner}/${repo}/${branch}`);

      return {
        success: true,
        commit: commitSha,
        branch,
        filesChanged: files || await this.getChangedFiles(projectPath),
      };
    } catch (error) {
      console.error('Failed to commit and push:', error.message);
      throw new Error(`Commit and push failed: ${error.message}`);
    }
  }

  /**
   * Check if repository has uncommitted changes
   * Used by SyncWorker to determine if push is needed
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<boolean>} True if there are uncommitted changes
   */
  async hasUncommittedChanges(projectPath) {
    try {
      const git = this.getGitInstance(projectPath);
      const status = await git.status();

      // Check if there are any modified, created, deleted, or untracked files
      return status.files.length > 0;
    } catch (error) {
      console.error('Failed to check uncommitted changes:', error.message);
      throw error;
    }
  }

  /**
   * Get list of changed files (modified, created, deleted, renamed)
   * Used by SyncWorker to track which files changed in sync
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<Array<string>>} Array of changed file paths
   */
  async getChangedFiles(projectPath) {
    try {
      const git = this.getGitInstance(projectPath);
      const status = await git.status();

      // Return all changed file paths
      return status.files.map(file => file.path);
    } catch (error) {
      console.error('Failed to get changed files:', error.message);
      throw error;
    }
  }

  async getWorkingTreeEntries(projectPath) {
    try {
      const git = this.getGitInstance(projectPath);
      const status = await git.status();
      return (Array.isArray(status.files) ? status.files : [])
        .map((file) => {
          const rawPath = typeof file?.path === 'string' ? file.path.trim() : '';
          const parsedRename = rawPath.match(/^(.*)\s+->\s+(.*)$/);
          const pathValue = String(file?.to || '').trim()
            || (parsedRename ? parsedRename[2].trim() : rawPath);
          const oldPathValue = String(file?.from || '').trim()
            || (parsedRename ? parsedRename[1].trim() : '');
          const statusCode = String(file?.working_dir || file?.index || '').trim().toUpperCase();
          const normalizedStatus = statusCode === '?' || statusCode === 'A'
            ? 'A'
            : statusCode === 'D'
              ? 'D'
              : statusCode === 'R'
                ? 'R'
                : 'M';
          if (!pathValue) return null;
          return {
            path: pathValue,
            oldPath: oldPathValue && oldPathValue !== pathValue ? oldPathValue : null,
            status: normalizedStatus,
          };
        })
        .filter(Boolean);
    } catch (error) {
      console.error('Failed to get working tree entries:', error.message);
      throw error;
    }
  }

  /**
   * Get current commit SHA (HEAD)
   * Used by SyncWorker to update github_last_sync_sha
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<string|null>} Current commit SHA or null if no commits
   */
  async getCurrentSHA(projectPath) {
    try {
      const git = this.getGitInstance(projectPath);
      const log = await git.log({ maxCount: 1 });

      return log.latest ? log.latest.hash : null;
    } catch (error) {
      if (String(error?.message || '').includes('does not have any commits yet')) {
        return null;
      }
      console.error('Failed to get current SHA:', error.message);
      throw error;
    }
  }

  // ============================================================================
  // CREATE REPOSITORY METHODS (Create GitHub Repo from AtlasEngine Project)
  // ============================================================================

  /**
   * Add a remote to git repository
   * Used when creating a new GitHub repository from an existing AtlasEngine project
   *
   * @param {string} projectPath - Project directory path
   * @param {string} remoteName - Remote name (usually 'origin')
   * @param {string} remoteUrl - Remote URL (HTTPS)
   * @param {string} token - GitHub access token for authentication
   * @returns {Promise<boolean>} Success status
   */
  async addRemote(projectPath, remoteName, remoteUrl, token) {
    try {
      const git = this.getGitInstance(projectPath);
      const sanitizedUrl = this.sanitizeRemoteUrl(remoteUrl);

      // Add remote
      await git.addRemote(remoteName, sanitizedUrl);

      console.log(`✅ Added remote '${remoteName}' to repository`);

      return true;
    } catch (error) {
      console.error(`Failed to add remote ${remoteName}:`, error.message);
      throw new Error(`Failed to add remote: ${error.message}`);
    }
  }

  /**
   * Initialize git repository (if needed), commit all files, and push to new remote
   * Used when creating a new GitHub repository from an AtlasEngine project
   *
   * @param {string} projectPath - Project directory path
   * @param {string} remoteUrl - Remote URL (HTTPS)
   * @param {string} token - GitHub access token
   * @param {string} branch - Branch name (default: 'main')
   * @param {string} commitMessage - Initial commit message (default: 'Initial commit from AtlasEngine')
   * @returns {Promise<Object>} Result with commit SHA and push details
   */
  async initAndPushToRemote(projectPath, remoteUrl, token, branch = 'main', commitMessage = 'Initial commit from AtlasEngine') {
    try {
      const git = this.getNonInteractiveGitInstance(projectPath);

      console.log(`🚀 Initializing and pushing ${projectPath} to new GitHub repository...`);

      // Check if already a git repository
      const isRepo = await this.isGitRepository(projectPath);

      if (!isRepo) {
        // Initialize git repository
        console.log(`📦 Initializing git repository...`);
        await git.init();

        // Set default branch name to 'main'
        await git.branch(['-M', branch]);
      } else {
        console.log(`ℹ️  Git repository already initialized`);
      }

      // Ensure .gitignore exists before staging files
      // Skip if .gitignore already exists with content (e.g., created at project init)
      const gitignorePath = path.join(projectPath, '.gitignore');
      let shouldCreateGitignore = !existsSync(gitignorePath);

      if (!shouldCreateGitignore) {
        // Check if existing .gitignore has meaningful content (> 50 chars)
        try {
          const existingContent = readFileSync(gitignorePath, 'utf8');
          if (existingContent.length > 50) {
            console.log(`ℹ️ .gitignore already exists with content, skipping creation`);
          } else {
            shouldCreateGitignore = true;
          }
        } catch {
          shouldCreateGitignore = true;
        }
      }

      if (shouldCreateGitignore) {
        console.log(`📝 Creating .gitignore file...`);
        const gitignoreContent = `# Dependencies
node_modules/
.pnp
.pnp.js

# Testing
coverage/

# Production
build/
dist/
*.tsbuildinfo

# Misc
.DS_Store
*.log
*.swp
*.swo
*~

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# IDE
.vscode/
.idea/
*.sublime-*

# Temporary files
*.tmp
tmp/
temp/

# Atlas Engine
.atlas/
`;
        writeFileSync(gitignorePath, gitignoreContent, 'utf8');
        console.log(`✅ Created .gitignore file`);
      }

      // Stage all files (respecting project's .gitignore)
      console.log(`📦 Staging all files...`);
      await git.add('.');

      // Check if there are any changes to commit
      const status = await git.status();
      if (status.files.length > 0) {
        // Commit all files
        console.log(`💾 Committing all files...`);
        const commitResult = await git.commit(commitMessage);
        console.log(`✅ Created initial commit: ${commitResult.commit}`);
      } else {
        console.log(`ℹ️  No files to commit (repository already has commits)`);
      }

      // Check if remote 'origin' already exists
      const remotes = await git.getRemotes();
      const hasOrigin = remotes.some(r => r.name === 'origin');

      if (hasOrigin) {
        // Update existing remote URL
        console.log(`🔗 Updating existing remote 'origin'...`);
        await this.setRemoteUrl(projectPath, remoteUrl, token, 'origin');
      } else {
        // Add new remote
        console.log(`🔗 Adding remote 'origin'...`);
        await this.addRemote(projectPath, 'origin', remoteUrl, token);
      }

      // Push to remote with --set-upstream
      console.log(`⬆️  Pushing to GitHub...`);
      await this.runAuthenticatedRemoteCommand(
        projectPath,
        ['push', 'origin', branch, '--set-upstream'],
        token
      );

      console.log(`✅ Successfully pushed to GitHub!`);

      // Get final commit SHA
      const commitSha = await this.getCurrentSHA(projectPath);

      return {
        success: true,
        commit: commitSha,
        branch,
        remote: 'origin',
      };
    } catch (error) {
      console.error('Failed to initialize and push to remote:', error.message);
      throw new Error(`Initialize and push failed: ${error.message}`);
    }
  }

  // ============================================================================
  // BRANCH REVIEW METHODS (Merge-base diffs, branch detection)
  // ============================================================================

  /**
   * Run git rev-parse with an argument
   *
   * @param {string} projectPath - Project directory path
   * @param {string} arg - Argument to pass to rev-parse
   * @returns {Promise<string>} Trimmed output
   */
  async getRevParse(projectPath, arg) {
    try {
      const git = this.getGitInstance(projectPath);
      const result = await git.raw(['rev-parse', arg]);
      return result.trim();
    } catch (error) {
      console.error(`Failed to rev-parse '${arg}':`, error.message);
      throw error;
    }
  }

  /**
   * Get current branch name (not detached HEAD)
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<string>} Branch name or "HEAD" if detached
   */
  async getCurrentBranchName(projectPath) {
    try {
      const git = this.getGitInstance(projectPath);
      const result = await git.raw(['rev-parse', '--abbrev-ref', 'HEAD']);
      return result.trim();
    } catch (error) {
      console.error('Failed to get current branch name:', error.message);
      throw error;
    }
  }

  /**
   * Get the merge-base (common ancestor) of two refs
   *
   * @param {string} projectPath - Project directory path
   * @param {string} ref1 - First ref
   * @param {string} ref2 - Second ref
   * @returns {Promise<string>} Merge-base SHA
   */
  async getMergeBase(projectPath, ref1, ref2) {
    try {
      const git = this.getGitInstance(projectPath);
      const result = await git.raw(['merge-base', ref1, ref2]);
      return result.trim();
    } catch (error) {
      console.error(`Failed to get merge-base for ${ref1} and ${ref2}:`, error.message);
      throw error;
    }
  }

  /**
   * Resolve a branch's fork point against its base via `git merge-base
   * --fork-point`. Uses the branch's reflog to identify the commit where the
   * branch diverged from the base, even if that commit is no longer a direct
   * ancestor in the base's current history (e.g. after a fast-forward merge).
   *
   * Returns `null` if the command fails or returns no output — typically
   * because the reflog is unavailable (fresh clone, CI, `git gc --prune=now`)
   * or the branch was never created from the given base.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} baseRef - Base ref (branch name or ref path)
   * @param {string} headRef - Head ref (branch name or ref path); defaults to HEAD
   * @returns {Promise<string|null>} The fork-point SHA or null when unrecoverable
   */
  async getForkPointFromReflog(projectPath, baseRef, headRef = 'HEAD') {
    const base = typeof baseRef === 'string' ? baseRef.trim() : '';
    const head = typeof headRef === 'string' ? headRef.trim() : '';
    if (!base || !head) return null;

    try {
      const git = this.getGitInstance(projectPath);
      const result = await git.raw(['merge-base', '--fork-point', base, head]);
      const trimmed = String(result || '').trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /**
   * Check whether one ref is an ancestor of another.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} ancestorRef - Candidate ancestor ref
   * @param {string} descendantRef - Candidate descendant ref
   * @returns {Promise<boolean>} True when ancestorRef is an ancestor of descendantRef
   */
  async isAncestorRef(projectPath, ancestorRef, descendantRef) {
    const ancestor = String(ancestorRef || '').trim();
    const descendant = String(descendantRef || '').trim();
    if (!ancestor || !descendant) return false;

    try {
      const git = this.getGitInstance(projectPath);
      await git.raw(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a ref exists in the repository
   *
   * @param {string} projectPath - Project directory path
   * @param {string} ref - Git ref to check
   * @returns {Promise<boolean>} True if ref exists
   */
  async refExists(projectPath, ref) {
    try {
      const git = this.getGitInstance(projectPath);
      // simple-git returns empty string for nonexistent refs with --quiet
      // instead of throwing, so check the result content
      const result = await git.raw(['rev-parse', '--verify', ref]);
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Resolve a ref to its commit SHA.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} ref - Git ref to resolve
   * @returns {Promise<string|null>} Commit SHA or null if the ref cannot be resolved
   */
  async getRefSha(projectPath, ref) {
    try {
      const git = this.getGitInstance(projectPath);
      const result = await git.raw(['rev-parse', '--verify', ref]);
      const sha = String(result || '').trim();
      return sha || null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch a specific ref from a remote
   *
   * @param {string} projectPath - Project directory path
   * @param {string} remote - Remote name (e.g. 'origin')
   * @param {string} branch - Branch name to fetch
   * @returns {Promise<{success: boolean, error?: string}>} Fetch result
   */
  async fetchRef(projectPath, remote, branch) {
    try {
      const git = this.getGitInstance(projectPath);
      await git.fetch(remote, branch);
      return { success: true };
    } catch (error) {
      console.warn(`Failed to fetch ${remote}/${branch}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get three-dot diff stats (numstat) between merge-base and a head ref.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} mergeBaseSha - Merge-base commit SHA
   * @param {string} [headRef='HEAD'] - Head ref (commit SHA/branch)
   * @returns {Promise<{files: Array<{path: string, additions: number, deletions: number}>, totalAdditions: number, totalDeletions: number, fileCount: number}>}
   */
  async getThreeDotDiffStats(projectPath, mergeBaseSha, headRef = 'HEAD') {
    try {
      const git = this.getGitInstance(projectPath);
      const range = buildDiffRange(mergeBaseSha, headRef);
      const raw = await git.raw(['diff', '--numstat', range]);

      const files = [];
      let totalAdditions = 0;
      let totalDeletions = 0;

      if (raw.trim()) {
        for (const line of raw.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
            const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
            const filePath = parts[2];
            files.push({ path: filePath, additions, deletions });
            totalAdditions += additions;
            totalDeletions += deletions;
          }
        }
      }

      return { files, totalAdditions, totalDeletions, fileCount: files.length };
    } catch (error) {
      console.error('Failed to get three-dot diff stats:', error.message);
      throw error;
    }
  }

  /**
   * Get three-dot diff name-status between merge-base and a head ref.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} mergeBaseSha - Merge-base commit SHA
   * @param {string} [headRef='HEAD'] - Head ref (commit SHA/branch)
   * @returns {Promise<Array<{status: string, path: string, oldPath?: string}>>}
   */
  async getThreeDotDiffNameStatus(projectPath, mergeBaseSha, headRef = 'HEAD') {
    try {
      const git = this.getGitInstance(projectPath);
      const range = buildDiffRange(mergeBaseSha, headRef);
      const raw = await git.raw(['diff', '--name-status', range]);

      const results = [];

      if (raw.trim()) {
        for (const line of raw.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const status = parts[0].charAt(0); // R100 -> R
            if (status === 'R' && parts.length >= 3) {
              results.push({ status, oldPath: parts[1], path: parts[2] });
            } else {
              results.push({ status, path: parts[1] });
            }
          }
        }
      }

      return results;
    } catch (error) {
      console.error('Failed to get three-dot diff name-status:', error.message);
      throw error;
    }
  }

  /**
   * Get two-dot diff stats (numstat) between two refs.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} fromRef - Lower-bound ref (exclusive)
   * @param {string} [toRef='HEAD'] - Upper-bound ref (inclusive)
   * @returns {Promise<{files: Array<{path: string, additions: number, deletions: number}>, totalAdditions: number, totalDeletions: number, fileCount: number, commitCount: number, firstCommitAt: string | null, lastCommitAt: string | null}>}
   */
  async getTwoDotDiffStats(projectPath, fromRef, toRef = 'HEAD') {
    try {
      const git = this.getGitInstance(projectPath);
      const range = `${fromRef}..${toRef || 'HEAD'}`;
      const raw = await git.raw(['diff', '--numstat', range]);
      const commitCountRaw = await git.raw(['rev-list', '--count', range]).catch(() => '0');
      const commitCount = Math.max(0, Number.parseInt(String(commitCountRaw || '0').trim(), 10) || 0);
      const [lastCommitAtRaw, oldestCommitShaRaw] = commitCount > 0
        ? await Promise.all([
            git.raw(['log', '-1', '--format=%cI', range]).catch(() => ''),
            git.raw(['rev-list', '--reverse', '--max-count=1', range]).catch(() => ''),
          ])
        : ['', ''];
      let firstCommitAtRaw = '';
      if (commitCount > 1) {
        const oldestCommitSha = String(oldestCommitShaRaw || '').trim();
        if (oldestCommitSha) {
          firstCommitAtRaw = await git.raw(['show', '-s', '--format=%cI', oldestCommitSha]).catch(() => '');
        }
      } else if (commitCount === 1) {
        firstCommitAtRaw = lastCommitAtRaw;
      }

      const files = [];
      let totalAdditions = 0;
      let totalDeletions = 0;

      if (raw.trim()) {
        for (const line of raw.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
            const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
            const filePath = parts[2];
            files.push({ path: filePath, additions, deletions });
            totalAdditions += additions;
            totalDeletions += deletions;
          }
        }
      }

      return {
        files,
        totalAdditions,
        totalDeletions,
        fileCount: files.length,
        commitCount,
        firstCommitAt: String(firstCommitAtRaw || '').trim() || null,
        lastCommitAt: String(lastCommitAtRaw || '').trim() || null,
      };
    } catch (error) {
      console.error('Failed to get two-dot diff stats:', error.message);
      throw error;
    }
  }

  /**
   * Get two-dot diff name-status between two refs.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} fromRef - Lower-bound ref (exclusive)
   * @param {string} [toRef='HEAD'] - Upper-bound ref (inclusive)
   * @returns {Promise<Array<{status: string, path: string, oldPath?: string}>>}
   */
  async getTwoDotDiffNameStatus(projectPath, fromRef, toRef = 'HEAD') {
    try {
      const git = this.getGitInstance(projectPath);
      const range = `${fromRef}..${toRef || 'HEAD'}`;
      const raw = await git.raw(['diff', '--name-status', range]);

      const results = [];

      if (raw.trim()) {
        for (const line of raw.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const status = parts[0].charAt(0);
            if (status === 'R' && parts.length >= 3) {
              results.push({ status, oldPath: parts[1], path: parts[2] });
            } else {
              results.push({ status, path: parts[1] });
            }
          }
        }
      }

      return results;
    } catch (error) {
      console.error('Failed to get two-dot diff name-status:', error.message);
      throw error;
    }
  }

  /**
   * Get unified patch for a single file between merge-base and head (three-dot range).
   * Returns raw `git diff -U3` output for the requested path(s).
   *
   * @param {string} projectPath - Project directory path
   * @param {string} mergeBaseSha - Merge-base commit SHA
   * @param {string} [headRef='HEAD'] - Head ref (commit SHA/branch)
   * @param {string} filePath - File path in the branch review manifest
   * @param {string|null} [oldPath=null] - Optional old path for renames
   * @returns {Promise<string>} Unified patch text (may be empty)
   */
  async getThreeDotFilePatch(projectPath, mergeBaseSha, headRef = 'HEAD', filePath, oldPath = null) {
    try {
      const git = this.getGitInstance(projectPath);
      const range = `${mergeBaseSha}...${headRef || 'HEAD'}`;

      const seen = new Set();
      const pathArgs = [];
      for (const candidate of [filePath, oldPath]) {
        const normalized = String(candidate || '').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        pathArgs.push(normalized);
      }

      const args = [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--unified=3',
        '--find-renames',
        range,
      ];
      if (pathArgs.length > 0) {
        args.push('--', ...pathArgs);
      }

      const raw = await git.raw(args);
      return typeof raw === 'string' ? raw : '';
    } catch (error) {
      console.error('Failed to get three-dot file patch:', error.message);
      throw error;
    }
  }

  /**
   * Get the full unified diff for all (or specific) files between merge-base and HEAD.
   * Follows the same pattern as getThreeDotFilePatch() but accepts an array of paths.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} mergeBaseSha - Merge-base SHA
   * @param {string} [headRef='HEAD'] - Head ref (SHA or branch)
   * @param {string[]|null} [filePaths=null] - Optional array of file paths to scope the diff
   * @returns {Promise<string>} Full unified diff text (may be empty)
   */
  async getThreeDotFullDiff(projectPath, mergeBaseSha, headRef = 'HEAD', filePaths = null) {
    try {
      const git = this.getGitInstance(projectPath);
      const range = buildDiffRange(mergeBaseSha, headRef);
      const args = ['diff', '--no-color', '--no-ext-diff', '--unified=3', '--find-renames', range];
      if (Array.isArray(filePaths) && filePaths.length > 0) {
        const unique = [...new Set(filePaths.map(p => String(p || '').trim()).filter(Boolean))];
        if (unique.length > 0) args.push('--', ...unique);
      }
      const raw = await git.raw(args);
      return typeof raw === 'string' ? raw : '';
    } catch (error) {
      console.error('Failed to get three-dot full diff:', error.message);
      throw error;
    }
  }

  /**
   * Get the full unified diff for all (or specific) files between two refs.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} fromRef - Lower-bound ref (exclusive)
   * @param {string} [toRef='HEAD'] - Upper-bound ref (inclusive)
   * @param {string[]|null} [filePaths=null] - Optional array of file paths to scope the diff
   * @returns {Promise<string>} Full unified diff text (may be empty)
   */
  async getTwoDotFullDiff(projectPath, fromRef, toRef = 'HEAD', filePaths = null) {
    try {
      const git = this.getGitInstance(projectPath);
      const range = `${fromRef}..${toRef || 'HEAD'}`;
      const args = ['diff', '--no-color', '--no-ext-diff', '--unified=3', '--find-renames', range];
      if (Array.isArray(filePaths) && filePaths.length > 0) {
        const unique = [...new Set(filePaths.map((entry) => String(entry || '').trim()).filter(Boolean))];
        if (unique.length > 0) args.push('--', ...unique);
      }
      const raw = await git.raw(args);
      return typeof raw === 'string' ? raw : '';
    } catch (error) {
      console.error('Failed to get two-dot full diff:', error.message);
      throw error;
    }
  }

  /**
   * Get file content at a specific git ref
   *
   * @param {string} projectPath - Project directory path
   * @param {string} ref - Git ref (commit SHA, branch name, etc.)
   * @param {string} filePath - Relative file path
   * @returns {Promise<string|null>} File content or null if not found
   */
  async getFileAtRef(projectPath, ref, filePath) {
    try {
      const git = this.getGitInstance(projectPath);
      return await git.show([`${ref}:${filePath}`]);
    } catch {
      return null; // File doesn't exist at that ref
    }
  }

  /**
   * Get commits between two refs
   *
   * @param {string} projectPath - Project directory path
   * @param {string} baseRef - Base ref (exclusive)
   * @param {string} headRef - Head ref (inclusive)
   * @returns {Promise<Array<{hash: string, message: string, author: string, date: string}>>}
   */
  async getCommitsBetween(projectPath, baseRef, headRef) {
    try {
      const git = this.getGitInstance(projectPath);
      const log = await git.log({ from: baseRef, to: headRef });
      return log.all.map(commit => ({
        hash: commit.hash,
        message: commit.message,
        author: commit.author_name,
        date: commit.date,
      }));
    } catch (error) {
      console.error(`Failed to get commits between ${baseRef}..${headRef}:`, error.message);
      throw error;
    }
  }

  /**
   * Get the default branch name from the remote
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<string|null>} Default branch name or null
   */
  async getRemoteDefaultBranch(projectPath) {
    try {
      const git = this.getNonInteractiveGitInstance(projectPath);
      const output = await git.raw(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      const branch = output.trim().replace(/^origin\//, '');
      return branch || null;
    } catch {
      return null;
    }
  }

  async sanitizeRemote(projectPath, remote = 'origin') {
    try {
      const currentUrl = await this.getRemoteUrl(projectPath, remote);
      const sanitizedUrl = this.sanitizeRemoteUrl(currentUrl);
      if (!sanitizedUrl || sanitizedUrl === currentUrl) {
        return currentUrl;
      }

      const git = this.getGitInstance(projectPath);
      await git.remote(['set-url', remote, sanitizedUrl]);
      console.log(`✅ Sanitized remote URL for ${remote}`);
      return sanitizedUrl;
    } catch (error) {
      console.warn(`Failed to sanitize remote URL for ${remote}:`, error.message);
      return null;
    }
  }

  /**
   * Resolve a branch name to a concrete git ref.
   * Prefers local refs, falls back to origin remote-tracking ref.
   *
   * @param {string} projectPath - Project directory path
   * @param {string} branchName - Branch name (without refs/* prefix)
   * @returns {Promise<string|null>} Resolved ref or null if not found
   */
  async resolveBranchRef(projectPath, branchName) {
    const name = String(branchName || '').trim();
    if (!name || name === 'HEAD') return null;

    const localRef = `refs/heads/${name}`;
    if (await this.refExists(projectPath, localRef)) {
      return localRef;
    }

    const remoteRef = `refs/remotes/origin/${name}`;
    if (await this.refExists(projectPath, remoteRef)) {
      return remoteRef;
    }

    return null;
  }

  /**
   * Infer the most likely base branch for a topic branch from git ancestry.
   * Strategy:
   * - Consider local branches (plus preferred/default branch hints)
   * - Keep only ancestors of the topic branch
   * - Pick the closest ancestor (minimum commit distance to topic HEAD)
   *
   * @param {string} projectPath - Project directory path
   * @param {string} branchName - Topic branch name
   * @param {Object} [options]
   * @param {string|null} [options.preferredBaseBranch] - Preferred fallback branch
   * @returns {Promise<string|null>} Inferred base branch name
   */
  async inferBaseBranch(projectPath, branchName, options = {}) {
    const topicBranch = String(branchName || '').trim();
    if (!topicBranch || topicBranch === 'HEAD') return null;

    const preferredBaseBranch = options.preferredBaseBranch
      ? String(options.preferredBaseBranch).trim()
      : null;

    const topicRef = await this.resolveBranchRef(projectPath, topicBranch);
    if (!topicRef) return preferredBaseBranch || null;

    const git = this.getGitInstance(projectPath);
    const remoteDefaultBranch = await this.getRemoteDefaultBranch(projectPath).catch(() => null);

    const localBranches = await this.listBranches(projectPath).catch(() => []);
    const candidates = new Set(
      localBranches
        .map((entry) => String(entry?.name || '').trim())
        .filter((name) => !!name && name !== topicBranch && !this.isSyntheticBaseBranchCandidate(name))
    );

    const remoteBranches = new Set();
    try {
      const remoteRaw = await git.raw(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']);
      for (const line of String(remoteRaw || '').split('\n')) {
        const ref = line.trim();
        if (!ref || ref === 'origin/HEAD') continue;
        if (!ref.startsWith('origin/')) continue;
        const name = ref.slice('origin/'.length).trim();
        if (!name || name === topicBranch || this.isSyntheticBaseBranchCandidate(name)) continue;
        remoteBranches.add(name);
        candidates.add(name);
      }
    } catch {
      // Remote refs may be unavailable offline; continue with local candidates.
    }

    if (preferredBaseBranch && preferredBaseBranch !== topicBranch) {
      candidates.add(preferredBaseBranch);
    }
    if (remoteDefaultBranch && remoteDefaultBranch !== topicBranch) {
      candidates.add(remoteDefaultBranch);
    }

    let best = null;

    for (const candidate of candidates) {
      const candidateRef = await this.resolveBranchRef(projectPath, candidate);
      if (!candidateRef) continue;

      let isAncestor = false;
      try {
        await git.raw(['merge-base', '--is-ancestor', candidateRef, topicRef]);
        isAncestor = true;
      } catch {
        isAncestor = false;
      }
      if (!isAncestor) continue;

      let distance = Number.POSITIVE_INFINITY;
      try {
        const rawDistance = await git.raw(['rev-list', '--count', `${candidateRef}..${topicRef}`]);
        distance = Number.parseInt(String(rawDistance || '').trim(), 10);
      } catch {
        continue;
      }
      // Keep zero-distance candidates. A freshly created branch can point at
      // the exact same commit as its base branch, and excluding distance=0
      // causes Atlas to "walk past" the true base and pick an older ancestor.
      if (!Number.isFinite(distance) || distance < 0) continue;

      const score = {
        distance,
        remote: remoteBranches.has(candidate) ? 0 : 1,
        preferred: preferredBaseBranch && candidate === preferredBaseBranch ? 0 : 1,
        remoteDefault: remoteDefaultBranch && candidate === remoteDefaultBranch ? 0 : 1,
        name: candidate,
      };

      if (
        !best
        || score.distance < best.distance
        || (score.distance === best.distance && score.remote < best.remote)
        || (score.distance === best.distance && score.remote === best.remote && score.preferred < best.preferred)
        || (
          score.distance === best.distance
          && score.remote === best.remote
          && score.preferred === best.preferred
          && score.remoteDefault < best.remoteDefault
        )
        || (
          score.distance === best.distance
          && score.remote === best.remote
          && score.preferred === best.preferred
          && score.remoteDefault === best.remoteDefault
          && score.name.localeCompare(best.name) < 0
        )
      ) {
        best = score;
      }
    }

    if (best?.name) return best.name;
    if (preferredBaseBranch && preferredBaseBranch !== topicBranch) return preferredBaseBranch;
    if (remoteDefaultBranch && remoteDefaultBranch !== topicBranch) return remoteDefaultBranch;
    return null;
  }
}

// Export singleton instance
const gitService = new GitService();
export default gitService;
