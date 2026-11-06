import { execFile } from 'child_process';
import { promisify } from 'util';
import { findClaudeBinary } from './claudeBinary.js';
import { buildClaudeCliEnv } from '../services/claudeTokenService.js';

const execFileAsync = promisify(execFile);

function isWindowsCommandShim(binary) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(binary || ''));
}

function execCli(binary, args, options) {
  if (!isWindowsCommandShim(binary)) {
    return execFileAsync(binary, args, options);
  }

  return execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', binary, ...args], options);
}

export async function getClaudeCliAuthStatus(token = '') {
  try {
    const { binary, args } = await findClaudeBinary();
    const { stdout } = await execCli(binary, [...args, 'auth', 'status', '--json'], {
      timeout: 15000,
      env: await buildClaudeCliEnv(process.env, token),
    });
    const parsed = JSON.parse(String(stdout || '').trim() || '{}');
    return {
      available: true,
      authenticated: parsed.loggedIn === true,
      source: typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
      details: parsed,
    };
  } catch (error) {
    return {
      available: false,
      authenticated: false,
      source: null,
      error: error?.message || 'Unable to verify CLI auth status',
    };
  }
}

export default {
  getClaudeCliAuthStatus,
};
