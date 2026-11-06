import fs from 'fs';
import path from 'path';
import db from '../db/connection.js';
import { decrypt, encrypt } from '../utils/encryption.js';
import logger from '../utils/logger.js';
import { getAppDataDir } from '../config/paths.js';

const CLAUDE_OAUTH_TOKEN_SETTING_KEY = 'claude_oauth_token_encrypted';

function normalizeToken(token) {
  return typeof token === 'string' ? token.trim() : '';
}

function pathExists(candidate) {
  if (!candidate) {
    return false;
  }

  try {
    fs.accessSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function getWindowsGitBashCandidates() {
  if (process.platform !== 'win32') {
    return [];
  }

  const candidates = [];
  const pushIfAbsolute = (candidate) => {
    if (candidate && path.isAbsolute(candidate)) {
      candidates.push(candidate);
    }
  };
  const configuredPath = normalizeToken(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  pushIfAbsolute(configuredPath);
  pushIfAbsolute(process.env.APPDATA && path.join(process.env.APPDATA, 'com.atlasengine.desktop', 'portable-git', 'bin', 'bash.exe'));
  pushIfAbsolute(getAppDataDir() && path.join(getAppDataDir(), 'portable-git', 'bin', 'bash.exe'));
  pushIfAbsolute(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'com.atlasengine.desktop', 'portable-git', 'bin', 'bash.exe'));
  pushIfAbsolute(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
  pushIfAbsolute(path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'));
  pushIfAbsolute(path.join(programFilesX86, 'Git', 'bin', 'bash.exe'));
  pushIfAbsolute(path.join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'));
  pushIfAbsolute(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  pushIfAbsolute(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'));

  return [...new Set(candidates)];
}

function resolveWindowsGitBashPath() {
  for (const candidate of getWindowsGitBashCandidates()) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  return '';
}

async function readStoredTokenValue() {
  const result = await db.query('SELECT value FROM settings WHERE id = $1', [
    CLAUDE_OAUTH_TOKEN_SETTING_KEY,
  ]);

  if (result.rows.length === 0) {
    return null;
  }

  const rawValue = result.rows[0]?.value;
  return typeof rawValue === 'string' && rawValue.trim() ? rawValue.trim() : null;
}

async function getStoredClaudeOAuthToken() {
  const storedValue = await readStoredTokenValue();
  if (!storedValue) {
    return normalizeToken(process.env.CLAUDE_CODE_OAUTH_TOKEN) || null;
  }

  try {
    const decrypted = normalizeToken(decrypt(storedValue));
    if (decrypted) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = decrypted;
      return decrypted;
    }
  } catch (error) {
    logger.warn('Failed to decrypt stored Claude OAuth token; clearing invalid stored value: %s', error.message);
    await clearStoredClaudeOAuthToken().catch((clearError) => {
      logger.warn('Failed to clear invalid stored Claude OAuth token: %s', clearError.message);
    });
    return null;
  }

  return null;
}

async function hasStoredClaudeOAuthToken() {
  const token = await getStoredClaudeOAuthToken();
  return Boolean(token);
}

/**
 * Existence-only check for a stored Claude OAuth token.
 *
 * Unlike `hasStoredClaudeOAuthToken()` (which calls `getStoredClaudeOAuthToken()`
 * and, as a side-effect, decrypts the value and mirrors it into
 * `process.env.CLAUDE_CODE_OAUTH_TOKEN`), this performs no decryption and no env
 * writes. Use it when the caller is about to clear the token anyway — re-mirroring
 * the about-to-be-deleted value would be pointless and makes the clear-then-retry
 * sequence fragile under future refactors.
 */
async function hasStoredClaudeOAuthTokenRecord() {
  if (normalizeToken(process.env.CLAUDE_CODE_OAUTH_TOKEN)) return true;
  try {
    return Boolean(await readStoredTokenValue());
  } catch {
    return false;
  }
}

async function saveStoredClaudeOAuthToken(token) {
  const cleanToken = normalizeToken(token);
  if (!cleanToken) {
    throw new Error('Claude OAuth token is required');
  }

  const encryptedToken = encrypt(cleanToken);

  await db.query(
    `INSERT INTO settings (id, value, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = CURRENT_TIMESTAMP`,
    [CLAUDE_OAUTH_TOKEN_SETTING_KEY, encryptedToken]
  );

  process.env.CLAUDE_CODE_OAUTH_TOKEN = cleanToken;
}

async function clearStoredClaudeOAuthToken() {
  // Drop the in-process mirror first: if the DB delete below throws, we still
  // want this process to stop injecting the (now-unwanted) token into `claude`
  // subprocesses, where it would keep shadowing the CLI's own `claude login`.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  await db.query('DELETE FROM settings WHERE id = $1', [CLAUDE_OAUTH_TOKEN_SETTING_KEY]);
}

async function buildClaudeCliEnv(baseEnv = process.env, token) {
  const effectiveToken = normalizeToken(token) || (await getStoredClaudeOAuthToken()) || '';
  const env = { ...baseEnv, NO_COLOR: '1' };
  if (effectiveToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = effectiveToken;
  }

  if (process.platform === 'win32') {
    const configuredBashPath = normalizeToken(env.CLAUDE_CODE_GIT_BASH_PATH);
    const bashPath = pathExists(configuredBashPath)
      ? configuredBashPath
      : resolveWindowsGitBashPath();
    if (bashPath) {
      env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;

      const bashDir = path.dirname(bashPath);
      const gitRoot = path.dirname(bashDir);
      const gitCmdPath = path.join(gitRoot, 'cmd');
      const currentPath = typeof env.PATH === 'string' ? env.PATH : '';
      const pathParts = currentPath ? currentPath.split(';') : [];
      if (!pathParts.includes(gitCmdPath)) {
        env.PATH = [gitCmdPath, ...pathParts].filter(Boolean).join(';');
      }
    } else {
      logger.warn('Claude CLI env could not resolve a Git Bash path on Windows.');
    }
  }

  return env;
}

export {
  CLAUDE_OAUTH_TOKEN_SETTING_KEY,
  getStoredClaudeOAuthToken,
  hasStoredClaudeOAuthToken,
  hasStoredClaudeOAuthTokenRecord,
  saveStoredClaudeOAuthToken,
  clearStoredClaudeOAuthToken,
  buildClaudeCliEnv,
};

export default {
  CLAUDE_OAUTH_TOKEN_SETTING_KEY,
  getStoredClaudeOAuthToken,
  hasStoredClaudeOAuthToken,
  hasStoredClaudeOAuthTokenRecord,
  saveStoredClaudeOAuthToken,
  clearStoredClaudeOAuthToken,
  buildClaudeCliEnv,
};
