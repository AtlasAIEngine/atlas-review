export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const w = window as typeof window & {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    isTauri?: boolean;
  };

  if (w.__TAURI_INTERNALS__ || w.__TAURI__ || w.isTauri) {
    return true;
  }

  const { protocol, hostname } = window.location;
  return protocol === 'tauri:' || hostname === 'tauri.localhost' || hostname === 'ipc.localhost';
}
