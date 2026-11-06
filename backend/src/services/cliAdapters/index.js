/**
 * CLI Adapter Registry
 * Central registry for CLI tool adapters. Each adapter handles binary discovery,
 * auth checking, argument construction, and stream parsing for its CLI.
 *
 * Usage:
 *   import { getAdapter, getAvailableAdapters } from './cliAdapters/index.js';
 *   const adapter = getAdapter('anthropic'); // ClaudeAdapter
 */

import claudeAdapter from './ClaudeAdapter.js';
import codexAdapter from './CodexAdapter.js';
import geminiAdapter from './GeminiAdapter.js';
import openCodeAdapter from './OpenCodeAdapter.js';

/**
 * Registry mapping provider type keys to adapter instances.
 * Keys match PROVIDER_CONFIGS keys from providerService.js.
 * @type {Map<string, import('./BaseCLIAdapter.js').BaseCLIAdapter>}
 */
const registry = new Map();

// Register built-in adapters
registry.set('anthropic', claudeAdapter);
registry.set('openai', codexAdapter);
registry.set('google', geminiAdapter);
registry.set('opencode', openCodeAdapter);

/**
 * Get the CLI adapter for a given provider type.
 * @param {string} providerType - Provider type key (e.g. 'anthropic', 'openai', 'google')
 * @returns {import('./BaseCLIAdapter.js').BaseCLIAdapter}
 * @throws {Error} if no adapter registered for the type
 */
export function getAdapter(providerType) {
  const adapter = registry.get(providerType);
  if (!adapter) {
    throw new Error(`No CLI adapter registered for provider type: ${providerType}`);
  }
  return adapter;
}

/**
 * Check if an adapter is registered for a given provider type.
 * @param {string} providerType
 * @returns {boolean}
 */
export function hasAdapter(providerType) {
  return registry.has(providerType);
}

/**
 * Resolve adapter from a runtime provider payload or provider type string.
 * Returns null instead of throwing when no adapter is registered.
 *
 * @param {string|{provider?: {type?: string}, type?: string}} providerLike
 * @returns {import('./BaseCLIAdapter.js').BaseCLIAdapter|null}
 */
export function getAdapterForProvider(providerLike) {
  const type = typeof providerLike === 'string'
    ? providerLike
    : (providerLike?.provider?.type || providerLike?.type || null);
  if (!type || !registry.has(type)) return null;
  return registry.get(type) || null;
}

/**
 * Get all adapters whose CLI binary is found on the system.
 * Useful for populating "available CLIs" in the frontend.
 * @returns {Promise<Array<{
 *   type: string,
 *   name: string,
 *   supported: boolean,
 *   defaultModel: string | null,
 *   models: Array<{alias: string, name: string, description: string}>
 * }>>}
 */
export async function getAvailableAdapters() {
  const results = [];
  for (const [type, adapter] of registry) {
    try {
      await adapter.findBinary();
      let models = [];
      try {
        models = adapter.getModels() || [];
      } catch {
        models = [];
      }

      results.push({
        type,
        name: adapter.getName(),
        supported: adapter.isSupported(),
        defaultModel: adapter.getDefaultModel?.() || null,
        models,
      });
    } catch {
      // Binary not found — skip
    }
  }
  return results;
}

/**
 * Get all registered adapters that report isSupported() === true.
 * @returns {Array<import('./BaseCLIAdapter.js').BaseCLIAdapter>}
 */
export function getSupportedAdapters() {
  return Array.from(registry.values()).filter(a => a.isSupported());
}

/**
 * Register a new adapter in the registry.
 * @param {string} providerType
 * @param {import('./BaseCLIAdapter.js').BaseCLIAdapter} adapter
 */
export function registerAdapter(providerType, adapter) {
  registry.set(providerType, adapter);
}

export default {
  getAdapter,
  getAdapterForProvider,
  hasAdapter,
  getAvailableAdapters,
  getSupportedAdapters,
  registerAdapter,
};
