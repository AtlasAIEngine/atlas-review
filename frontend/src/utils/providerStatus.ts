import type { AIProvider } from '@/types';

/**
 * "Can the user select this provider and have it route to a real CLI/API?"
 *
 * True for verified `connected` providers AND for `unchecked` CLI-detected
 * providers (e.g. macOS Keychain / Windows Credential Manager Claude where
 * we couldn't verify offline but post-login artifacts prove past auth).
 *
 * Use this for: selection lists, "Use" button visibility, "any provider
 * configured?" empty-state checks, build/chat dropdowns.
 *
 * Do NOT use this for: auto-activation, silent failover. Those should stay
 * strict on `isProviderConfirmedConnected`.
 */
export function isProviderUsable(
  provider: AIProvider | null | undefined,
): boolean {
  if (!provider) return false;
  if (provider.status === 'connected') return true;
  if (provider.status === 'unchecked' && provider.source === 'cli_detected') return true;
  return false;
}

/**
 * "Is this provider verified working right now?" — strict.
 *
 * Use for auto-activation, silent failover, health-check-driven UI.
 */
export function isProviderConfirmedConnected(
  provider: AIProvider | null | undefined,
): boolean {
  return provider?.status === 'connected';
}
