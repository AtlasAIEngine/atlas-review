/**
 * Open an external URL in the system browser.
 * In Tauri, uses the shell plugin. In browser mode, uses window.open.
 */

import { isTauriEnvironment } from './tauri';

export async function openExternal(url: string): Promise<void> {
  if (isTauriEnvironment()) {
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
      return;
    } catch (err) {
      console.warn('[openExternal] Shell plugin failed, falling back to window.open:', err);
    }
  }
  window.open(url, '_blank');
}
