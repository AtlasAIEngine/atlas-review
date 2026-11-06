/**
 * Claude Routes
 * API endpoints for Claude Code CLI detection and authentication
 * 
 * Security notes:
 * - These routes are for local development use (single-user MVP)
 * - For production, add proper authentication middleware
 */

import express from 'express';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import fs from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import logger from '../utils/logger.js';
import { getClaudeCliAuthStatus } from '../utils/claudeAuthStatus.js';
import { findClaudeBinary } from '../utils/claudeBinary.js';
import providerService from '../services/providerService.js';
import {
  buildClaudeCliEnv,
  clearStoredClaudeOAuthToken,
  getStoredClaudeOAuthToken,
  hasStoredClaudeOAuthToken,
  saveStoredClaudeOAuthToken,
} from '../services/claudeTokenService.js';

/**
 * Get model aliases from the single source of truth in providerService.
 * Replaces the old hardcoded MODEL_ALIASES array.
 */
function getModelAliases() {
  return providerService.getAnthropicCLIModels();
}

// Cached discovered models (populated by /api/claude/models/discover)
let discoveredModelsCache = null;
let modelsCacheTimestamp = null;
const MODELS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

const execFileAsync = promisify(execFile);
const router = express.Router();

// Cache auth status for 5 minutes
let authCache = null;
const AUTH_CACHE_TTL = 5 * 60 * 1000;

// Simple in-memory rate limiting (per-route)
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 10000; // 10 seconds
const RATE_LIMIT_MAX = 5; // max requests per window

function looksLikeClaudeOAuthToken(token) {
  const value = typeof token === 'string' ? token.trim() : '';
  return /^sk-ant-oat/i.test(value) && value.length >= 40;
}

async function execClaudeCommand(binary, args, options = {}) {
  const execOptions = { ...options };

  if (process.platform === 'win32' && path.basename(binary).toLowerCase() === 'node.exe') {
    const env = execOptions.env || process.env;
    const scriptPath = path.join(tmpdir(), `atlas-claude-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
    const stdoutPath = path.join(tmpdir(), `atlas-claude-stdout-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const stderrPath = path.join(tmpdir(), `atlas-claude-stderr-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const argList = `@(${args.map(quote).join(', ')})`;
    const psLines = [
      `$ErrorActionPreference = 'Stop'`,
      ...(execOptions.cwd ? [`Set-Location ${quote(execOptions.cwd)}`] : []),
      ...(env.CLAUDE_CODE_OAUTH_TOKEN ? [`$env:CLAUDE_CODE_OAUTH_TOKEN = ${quote(env.CLAUDE_CODE_OAUTH_TOKEN)}`] : []),
      ...(env.CLAUDE_CODE_GIT_BASH_PATH ? [`$env:CLAUDE_CODE_GIT_BASH_PATH = ${quote(env.CLAUDE_CODE_GIT_BASH_PATH)}`] : []),
      ...(env.NO_COLOR ? [`$env:NO_COLOR = ${quote(env.NO_COLOR)}`] : []),
      ...(env.PATH ? [`$env:PATH = ${quote(env.PATH)}`] : []),
      `$stdoutPath = ${quote(stdoutPath)}`,
      `$stderrPath = ${quote(stderrPath)}`,
      `Remove-Item $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue`,
      `$process = Start-Process -FilePath ${quote(binary)} -ArgumentList ${argList} -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath`,
      `if (Test-Path $stdoutPath) { [Console]::Out.Write((Get-Content -Raw $stdoutPath)) }`,
      `if (Test-Path $stderrPath) { [Console]::Error.Write((Get-Content -Raw $stderrPath)) }`,
      `$exitCode = if ($process) { $process.ExitCode } else { 1 }`,
      `Remove-Item $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue`,
      `exit $exitCode`,
    ];

    await writeFile(scriptPath, psLines.join('\r\n'), 'utf8');

    try {
      return await execFileAsync(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        execOptions,
      );
    } finally {
      await unlink(scriptPath).catch(() => {});
    }
  }

  if (!execOptions.cwd && path.basename(binary).toLowerCase() === 'node.exe') {
    execOptions.cwd = path.dirname(binary);
  }

  return execFileAsync(binary, args, execOptions);
}

function shouldUseSpawnForClaude(binary, args = []) {
  if (process.platform === 'win32') {
    return false;
  }

  const base = path.basename(binary).toLowerCase();
  return (base === 'claude' || base === 'node') && args.includes('--print');
}

function buildClaudeCommandError(binary, args, { code, signal, killed, stdout, stderr }) {
  const error = new Error(`Command failed: ${[binary, ...args].join(' ')}\n`);
  error.code = code;
  error.signal = signal || null;
  error.killed = Boolean(killed);
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

async function spawnClaudeCommand(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    const child = spawn(binary, args, spawnOptions);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    let timeoutId = null;
    if (Number.isFinite(options.timeout) && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeout);
    }

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    child.on('error', (error) => {
      cleanup();
      reject(error);
    });

    child.on('close', (code, signal) => {
      cleanup();
      if (!timedOut && code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(buildClaudeCommandError(binary, args, {
        code: timedOut ? 143 : code,
        signal,
        killed: timedOut,
        stdout,
        stderr,
      }));
    });
  });
}

async function runClaudeCommand(binary, args, options = {}) {
  if (shouldUseSpawnForClaude(binary, args)) {
    return spawnClaudeCommand(binary, args, options);
  }

  return execClaudeCommand(binary, args, options);
}

function checkRateLimit(key) {
  const now = Date.now();
  const record = rateLimits.get(key) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + RATE_LIMIT_WINDOW;
  } else {
    record.count++;
  }
  
  rateLimits.set(key, record);
  return record.count <= RATE_LIMIT_MAX;
}

// findClaudeBinary() imported from ../utils/claudeBinary.js

/**
 * Check if Claude CLI is installed (async)
 */
async function isClaudeInstalled() {
  try {
    const { binary, args } = await findClaudeBinary();
    const { stdout, stderr } = await runClaudeCommand(binary, [...args, '--version'], {
      timeout: 15000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    
    const version = stdout.trim() || stderr.trim();
    return { installed: true, version };
  } catch (error) {
    logger.warn('Claude CLI not found:', error.message);
    return { installed: false, version: null };
  }
}

async function getClaudeStatusData() {
  const installStatus = await isClaudeInstalled();

  if (!installStatus.installed) {
    return {
      installed: false,
      version: null,
      authenticated: false,
      hasNativeAuth: false,
      hasStoredToken: false,
      hasOAuthToken: false,
    };
  }

  const [storedToken, nativeAuth] = await Promise.all([
    getStoredClaudeOAuthToken(),
    checkNativeAuth(),
  ]);

  return {
    installed: true,
    version: installStatus.version,
    authenticated: nativeAuth.authenticated || Boolean(storedToken),
    hasNativeAuth: nativeAuth.authenticated,
    hasStoredToken: Boolean(storedToken),
    hasOAuthToken: Boolean(storedToken),
    nativeAuthSource: nativeAuth.source || null,
  };
}

/**
 * Check if Claude CLI has native authentication
 * Reads ~/.claude/credentials.json to check for valid OAuth tokens
 * 
 * Note: We check if credentials exist with a refresh token, rather than
 * strictly checking access token expiration. The CLI handles token refresh
 * automatically, so if a refresh token exists, the CLI can authenticate.
 */
async function checkNativeAuth() {
  const cliAuthStatus = await getClaudeCliAuthStatus();
  if (cliAuthStatus.available) {
    return {
      authenticated: cliAuthStatus.authenticated,
      source: cliAuthStatus.source,
      error: cliAuthStatus.authenticated ? null : 'Not logged in',
    };
  }

  logger.debug('Claude CLI auth status probe failed, falling back to credential files: %s', cliAuthStatus.error || 'unknown');

  try {
    // Newer Claude CLI versions use .credentials.json (dot-prefixed);
    // older versions used credentials.json.  Try both.
    const claudeDir = path.join(homedir(), '.claude');
    let content;
    try {
      content = await readFile(path.join(claudeDir, '.credentials.json'), 'utf-8');
    } catch {
      content = await readFile(path.join(claudeDir, 'credentials.json'), 'utf-8');
    }
    const credentials = JSON.parse(content);
    
    // Check if OAuth credentials exist
    if (credentials.claudeAiOauth) {
      const { accessToken, refreshToken, expiresAt } = credentials.claudeAiOauth;
      
      // If we have a refresh token, the CLI can handle re-authentication
      // automatically, so we consider it authenticated
      if (refreshToken) {
        return { authenticated: true, error: null };
      }
      
      // Fallback: check if access token exists and isn't expired
      if (accessToken && expiresAt) {
        const now = Date.now();
        const bufferMs = 5 * 60 * 1000;
        
        if (expiresAt > now + bufferMs) {
          return { authenticated: true, error: null };
        } else {
          return { authenticated: false, error: 'Token expired (no refresh token)' };
        }
      }
    }
    
    return { authenticated: false, error: 'No credentials found' };
  } catch (error) {
    // File doesn't exist or can't be read - not authenticated
    if (error.code === 'ENOENT') {
      return { authenticated: false, error: 'Not logged in' };
    }
    logger.warn('Failed to read Claude credentials:', error.message);
    return { authenticated: false, error: 'Unable to verify authentication' };
  }
}

/**
 * GET /api/claude/status
 * Check Claude CLI installation and authentication status
 */
router.get('/status', async (req, res) => {
  try {
    const refreshRequested = req.query?.refresh === '1' || req.query?.refresh === 'true';
    // Check cache first — cached responses bypass the rate limiter entirely.
    // This prevents 429s from rapid app reloads and React strict mode double-invocations.
    if (!refreshRequested && authCache && Date.now() - authCache.timestamp < AUTH_CACHE_TTL) {
      return res.json({
        success: true,
        data: authCache.data,
        cached: true,
      });
    }

    // Rate limiting only applies to uncached requests (i.e., first call or after cache expiry)
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!checkRateLimit(`status:${clientIp}`)) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please wait before checking again.',
      });
    }

    const data = await getClaudeStatusData();

    // Cache the result
    authCache = { data, timestamp: Date.now() };

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    logger.error('Error checking Claude status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check Claude status',
    });
  }
});

/**
 * POST /api/claude/test
 * Test Claude connection with optional token
 * 
 * If no token is provided, checks native CLI auth first (fast path).
 * Only runs the actual CLI test if explicitly testing a new token OR
 * if native auth check fails.
 */
router.post('/test', async (req, res) => {
  try {
    // Rate limiting
    if (!checkRateLimit('test')) {
      return res.status(429).json({
        success: false,
        error: 'Too many test requests. Please wait before trying again.',
      });
    }

    const { token } = req.body;
    const cleanToken = typeof token === 'string' ? token.trim() : '';

    // Fast path: if no token provided, check native auth first
    // This avoids spawning the CLI when we already know auth exists
    if (!cleanToken) {
      const [nativeAuth, storedToken] = await Promise.all([
        checkNativeAuth(),
        getStoredClaudeOAuthToken(),
      ]);
      if (nativeAuth.authenticated) {
        res.json({
          success: true,
          data: {
            authenticated: true,
            source: 'native', // Indicate this was via native CLI auth
          },
        });
        return;
      }

      if (!storedToken) {
        res.json({
          success: true,
          data: {
            authenticated: false,
            error: 'Claude CLI is not authenticated. Run "claude login" or paste a Claude OAuth token.',
          },
        });
        return;
      }
    }

    const { binary, args } = await findClaudeBinary();

    try {
      // Use --print with a minimal prompt to actually test authentication
      // --version doesn't require auth, so it can't validate tokens
      await runClaudeCommand(binary, [...args, '--print', '-p', 'hi'], {
        timeout: 30000, // Auth commands may take longer
        env: await buildClaudeCliEnv(process.env, cleanToken),
      });

      // Invalidate cache on successful test (state may have changed)
      authCache = null;

      res.json({
        success: true,
        data: {
          authenticated: true,
        },
      });
    } catch (error) {
      // Check both message and stderr
      const stderrText = typeof error.stderr === 'string' ? error.stderr.trim() : '';
      const stdoutText = typeof error.stdout === 'string' ? error.stdout.trim() : '';
      const errorOutput = [
        stderrText,
        stdoutText,
        error.message || '',
      ].join(' ').toLowerCase();
      
      const isAuthError = 
        errorOutput.includes('api key') || 
        errorOutput.includes('auth') ||
        errorOutput.includes('invalid') ||
        errorOutput.includes('expired') ||
        errorOutput.includes('unauthorized') ||
        errorOutput.includes('login');

      const isGitBashError =
        stderrText.toLowerCase().includes('git-bash')
        || stderrText.toLowerCase().includes('git bash')
        || stderrText.toLowerCase().includes('bash.exe');
      const canUseDeferredWindowsValidation =
        process.platform === 'win32'
        && Boolean(cleanToken)
        && looksLikeClaudeOAuthToken(cleanToken)
        && !stderrText
        && !stdoutText
        && String(error.message || '').includes('Command failed:')
        && String(error.signal || '').toUpperCase() === 'SIGTERM';

      if (canUseDeferredWindowsValidation) {
        logger.warn('Claude token validation hit Windows CLI false-negative path; allowing deferred validation.');
        res.json({
          success: true,
          data: {
            authenticated: true,
            deferredValidation: true,
          },
        });
        return;
      }
      
      res.json({
        success: true,
        data: {
          authenticated: false,
          error: isGitBashError
            ? 'Claude Code on Windows requires Git Bash. Install Git Bash or configure CLAUDE_CODE_GIT_BASH_PATH.'
            : isAuthError
              ? 'Invalid or expired token'
              : (stderrText || stdoutText || `Connection test failed: ${error.message}`),
        },
      });
    }
  } catch (error) {
    logger.error('Error testing Claude connection:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to test connection',
    });
  }
});

/**
 * POST /api/claude/token
 * Save OAuth token
 */
router.post('/token', async (req, res) => {
  try {
    // Rate limiting
    if (!checkRateLimit('token')) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please wait before trying again.',
      });
    }

    const { token } = req.body;
    
    // Trim and validate token
    const cleanToken = token?.trim();

    if (!cleanToken) {
      return res.status(400).json({
        success: false,
        error: 'Token is required',
      });
    }

    // Basic sanity check (tokens are typically long strings)
    if (cleanToken.length < 20) {
      return res.status(400).json({
        success: false,
        error: 'Token appears to be invalid (too short)',
      });
    }

    await saveStoredClaudeOAuthToken(cleanToken);

    // Invalidate cache
    authCache = null;

    logger.info('Claude OAuth token saved (length: %d)', cleanToken.length);

    res.json({
      success: true,
      message: 'Token saved successfully',
    });
  } catch (error) {
    logger.error('Error saving Claude token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save token',
    });
  }
});

/**
 * DELETE /api/claude/token
 * Clear OAuth token
 */
router.delete('/token', async (req, res) => {
  try {
    await clearStoredClaudeOAuthToken();
    
    // Invalidate cache
    authCache = null;

    logger.info('Claude OAuth token cleared');

    res.json({
      success: true,
      message: 'Token cleared successfully',
    });
  } catch (error) {
    logger.error('Error clearing Claude token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear token',
    });
  }
});

/**
 * Probe a single model alias to get its full version
 * Returns { alias, fullName, available } or null on error
 */
async function probeModel(alias) {
  try {
    const { binary, args } = await findClaudeBinary();
    const { stdout } = await runClaudeCommand(binary, [
      ...args,
      '--print',
      '--output-format', 'json',
      '--model', alias,
      '-p', 'hi'
    ], {
      timeout: 30000,
      env: await buildClaudeCliEnv(process.env),
    });

    // Parse the JSON response to extract model name
    const response = JSON.parse(stdout.trim());
    const fullName = response.model || alias;
    
    // Format display name from full name (e.g., "claude-opus-4-5-20251101" -> "Claude Opus 4.5")
    let displayName = alias.charAt(0).toUpperCase() + alias.slice(1);
    if (fullName.includes('opus')) {
      const match = fullName.match(/opus-(\d+)-(\d+)/);
      if (match) displayName = `Claude Opus ${match[1]}.${match[2]}`;
    } else if (fullName.includes('sonnet')) {
      const match = fullName.match(/sonnet-(\d+)-(\d+)/);
      if (match) displayName = `Claude Sonnet ${match[1]}.${match[2]}`;
    } else if (fullName.includes('haiku')) {
      const match = fullName.match(/haiku-(\d+)-(\d+)/);
      if (match) displayName = `Claude Haiku ${match[1]}.${match[2]}`;
    }

    return { alias, fullName, displayName, available: true };
  } catch (error) {
    logger.warn(`Model probe failed for ${alias}:`, error.message);
    return { alias, fullName: null, displayName: alias, available: false };
  }
}

/**
 * GET /api/claude/models
 * Get available models and user's default model from settings
 * Uses cached discovery if available, otherwise returns static list
 */
router.get('/models', async (req, res) => {
  try {
    // Rate limiting
    if (!checkRateLimit('models')) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please wait before checking again.',
      });
    }

    // Read user's default model from settings
    let defaultModel = 'sonnet'; // Default fallback
    try {
      const settingsPath = path.join(homedir(), '.claude', 'settings.json');
      const settingsContent = await readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsContent);
      
      if (settings.model) {
        // Extract model alias from full name (e.g., "claude-opus-4-5-20251101" -> "opus")
        const modelName = settings.model.toLowerCase();
        if (modelName.includes('opus')) {
          defaultModel = 'opus';
        } else if (modelName.includes('haiku')) {
          defaultModel = 'haiku';
        } else if (modelName.includes('sonnet')) {
          defaultModel = 'sonnet';
        } else {
          // Use as-is if it's already an alias or unknown model
          defaultModel = settings.model;
        }
      }
    } catch (error) {
      // Settings file doesn't exist or can't be read - use default
      logger.debug('Could not read Claude settings, using default model:', error.message);
    }

    // Use discovered cache if valid AND has models
    let models;
    const cacheValid = discoveredModelsCache && 
                       discoveredModelsCache.length > 0 && 
                       modelsCacheTimestamp && 
                       (Date.now() - modelsCacheTimestamp) < MODELS_CACHE_TTL;
    
    if (cacheValid) {
      models = discoveredModelsCache;
    } else {
      // Clear invalid cache
      if (discoveredModelsCache && discoveredModelsCache.length === 0) {
        discoveredModelsCache = null;
        modelsCacheTimestamp = null;
      }
      // Fall back to static aliases with version names
      models = getModelAliases().map(m => ({
        id: m.alias,
        alias: m.alias,
        name: m.name,
        description: m.description,
        discovered: false,
      }));
    }

    res.json({
      success: true,
      data: {
        models,
        defaultModel,
        cached: cacheValid,
        cacheAge: cacheValid ? Date.now() - modelsCacheTimestamp : null,
      },
    });
  } catch (error) {
    logger.error('Error getting Claude models:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get models',
    });
  }
});

/**
 * POST /api/claude/models/discover
 * Probe each model alias to discover actual versions
 * This makes API calls, so use sparingly
 */
router.post('/models/discover', async (req, res) => {
  try {
    // Rate limiting (stricter - this is expensive)
    if (!checkRateLimit('discover')) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please wait before discovering again.',
      });
    }

    // Check auth first (accept both native auth and token-based auth)
    const authResult = await checkNativeAuth();
    const hasStoredToken = await hasStoredClaudeOAuthToken();

    if (!authResult.authenticated && !hasStoredToken) {
      return res.status(401).json({
        success: false,
        error: 'Claude CLI not authenticated. Please run `claude login` or set an OAuth token.',
      });
    }

    logger.info('Starting model discovery...');
    const results = [];

    // Probe each model alias
    for (const modelDef of getModelAliases()) {
      logger.info(`Probing model: ${modelDef.alias}`);
      const result = await probeModel(modelDef.alias);
      results.push({
        id: modelDef.alias,
        alias: modelDef.alias,
        name: result.displayName,
        fullName: result.fullName,
        description: modelDef.description,
        available: result.available,
        discovered: true,
      });
    }

    // Cache the results
    discoveredModelsCache = results.filter(m => m.available);
    modelsCacheTimestamp = Date.now();

    logger.info(`Model discovery complete. Found ${discoveredModelsCache.length} available models.`);

    res.json({
      success: true,
      data: {
        models: results,
        availableCount: discoveredModelsCache.length,
        cachedAt: modelsCacheTimestamp,
      },
    });
  } catch (error) {
    logger.error('Error discovering models:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to discover models',
    });
  }
});

/**
 * PUT /api/claude/models/default
 * Update user's default model in Claude settings
 */
router.put('/models/default', async (req, res) => {
  try {
    const { model } = req.body;
    
    if (!model) {
      return res.status(400).json({
        success: false,
        error: 'Model is required',
      });
    }

    // Validate model against known aliases
    const validAliases = getModelAliases().map(m => m.alias);
    if (!validAliases.includes(model)) {
      return res.status(400).json({
        success: false,
        error: `Invalid model. Valid options: ${validAliases.join(', ')}`,
      });
    }

    // Read existing settings
    const claudeDir = path.join(homedir(), '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings = {};
    try {
      const settingsContent = await readFile(settingsPath, 'utf-8');
      settings = JSON.parse(settingsContent);
    } catch (error) {
      // Settings file doesn't exist - create new
      logger.debug('Creating new Claude settings file');
    }

    // Update model
    settings.model = model;

    // Ensure ~/.claude directory exists before writing
    await mkdir(claudeDir, { recursive: true });

    // Write back
    await writeFile(settingsPath, JSON.stringify(settings, null, 2));

    logger.info('Updated default Claude model to: %s', model);

    res.json({
      success: true,
      message: 'Default model updated',
      model,
    });
  } catch (error) {
    logger.error('Error updating default model:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update default model',
    });
  }
});

/**
 * Clear all in-memory caches (for sign-out reset).
 */
export function clearClaudeCache() {
  authCache = null;
  discoveredModelsCache = null;
  modelsCacheTimestamp = null;
}

export default router;
