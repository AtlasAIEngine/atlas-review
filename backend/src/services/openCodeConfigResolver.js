/**
 * OpenCode Config Resolver — Shared utility for reading OpenCode's config/auth files
 * and resolving the underlying provider, model, and API key.
 *
 * Used by both the review path (direct API calls) and the builder chat path
 * (streaming API bypass) when `opencode run` CLI is unavailable or broken.
 */

import { readFile } from 'fs/promises';
import { join as pathJoin } from 'path';
import { homedir } from 'os';

/**
 * Read OpenCode's config + auth files and return the underlying provider
 * type, bare model name, and API key so we can call the provider API directly.
 *
 * @returns {Promise<{ providerType: string, bareModel: string, apiKey: string } | null>}
 */
export async function resolveOpenCodeDirectApiParams() {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME || pathJoin(home, '.config');
  const xdgData = process.env.XDG_DATA_HOME || pathJoin(home, '.local', 'share');

  // 1. Read the active model from opencode.json  (e.g. "google/gemini-2.5-flash")
  let activeModel = null;
  const configCandidates = [
    pathJoin(xdgConfig, 'opencode', 'opencode.json'),
    pathJoin(xdgConfig, 'opencode', 'opencode.jsonc'),
    pathJoin(home, '.opencode', 'config.json'),
    pathJoin(xdgConfig, 'opencode', 'config.json'),
  ];
  for (const cfgPath of configCandidates) {
    try {
      const raw = await readFile(cfgPath, 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg.model && typeof cfg.model === 'string') {
        activeModel = cfg.model;
        break;
      }
    } catch { /* next candidate */ }
  }
  if (!activeModel || !activeModel.includes('/')) return null;

  // 2. Derive provider type and bare model name
  //    e.g. "google/gemini-2.5-flash"     → providerType='google',   bareModel='gemini-2.5-flash'
  //    e.g. "nvidia/meta/llama-3.1-8b..."  → providerType='nvidia',  bareModel='meta/llama-3.1-8b...'
  const slashIdx = activeModel.indexOf('/');
  const providerType = activeModel.slice(0, slashIdx);
  const bareModel = activeModel.slice(slashIdx + 1);

  // Only support providers we have direct API functions for
  if (!['google', 'anthropic', 'openai', 'nvidia'].includes(providerType)) return null;

  // 3. Read the API key from auth.json
  const authPath = pathJoin(xdgData, 'opencode', 'auth.json');
  let apiKey = null;
  try {
    const raw = await readFile(authPath, 'utf8');
    const auth = JSON.parse(raw);
    const entry = auth[providerType];
    if (entry && entry.type === 'api' && entry.key) {
      apiKey = entry.key;
    }
  } catch { /* no auth file */ }

  if (!apiKey) return null;

  return { providerType, bareModel, apiKey };
}
