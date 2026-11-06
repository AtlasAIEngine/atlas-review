/**
 * Linter Detection — Project-level tool availability detection.
 * Used by review policy generation to auto-populate the linters section.
 */

import * as eslintAdapter from './eslintAdapter.js';
import * as tscAdapter from './tscAdapter.js';
import * as dotnetAdapter from './dotnetAdapter.js';
import * as dotnetFormatAdapter from './dotnetFormatAdapter.js';
import * as semgrepAdapter from './semgrepAdapter.js';

const ALL_ADAPTERS = [eslintAdapter, tscAdapter, dotnetAdapter, dotnetFormatAdapter, semgrepAdapter];

/**
 * Detect which linters should be enabled by default in starter policy.
 * This stays repo-stable and must not depend on local machine binaries.
 */
export function detectAvailableLinters(projectPath) {
  const result = {};
  for (const adapter of ALL_ADAPTERS) {
    try {
      const metadata = typeof adapter.getDetectionMetadata === 'function'
        ? adapter.getDetectionMetadata(projectPath)
        : null;
      result[adapter.id] = {
        available: Boolean(metadata
          ? (metadata.policyDefaultEligible || metadata.atlasManagedEligible)
          : adapter.detectProjectAvailability(projectPath)),
        ...(metadata && Object.prototype.hasOwnProperty.call(metadata, 'defaultEnabled')
          ? { defaultEnabled: metadata.defaultEnabled !== false }
          : {}),
      };
    } catch {
      result[adapter.id] = { available: false };
    }
  }
  return result;
}

/**
 * Detect richer linter status for UI display.
 * This may include machine-local runtime readiness, but keeps starter-policy
 * eligibility separated from runtime execution readiness.
 */
export function detectLinterStatus(projectPath) {
  const result = {};
  for (const adapter of ALL_ADAPTERS) {
    try {
      if (typeof adapter.getDetectionMetadata === 'function') {
        result[adapter.id] = adapter.getDetectionMetadata(projectPath);
      } else {
        const available = adapter.detectProjectAvailability(projectPath);
        result[adapter.id] = {
          policyDefaultEligible: available,
          runtimeReady: available,
          atlasManagedEligible: false,
          effectiveMode: available ? 'project_linter' : 'unavailable',
          hasConfig: available,
          hasBinary: null,
          configLabel: null,
          binaryLabel: null,
        };
      }
    } catch {
        result[adapter.id] = {
          policyDefaultEligible: false,
          runtimeReady: false,
          atlasManagedEligible: false,
          effectiveMode: 'unavailable',
          hasConfig: false,
          hasBinary: false,
          configLabel: null,
        binaryLabel: null,
      };
    }
  }
  return result;
}
