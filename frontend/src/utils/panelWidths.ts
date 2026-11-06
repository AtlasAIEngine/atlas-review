export interface PanelWidths {
  leftWidth: number;
  rightWidth?: number;
}

export function loadPanelWidths(storageKey: string): PanelWidths | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PanelWidths>;
    if (!Number.isFinite(parsed.leftWidth)) {
      return null;
    }
    return {
      leftWidth: Number(parsed.leftWidth),
      ...(Number.isFinite(parsed.rightWidth) ? { rightWidth: Number(parsed.rightWidth) } : {}),
    };
  } catch {
    return null;
  }
}

export function savePanelWidths(storageKey: string, widths: PanelWidths): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(widths));
  } catch {
    // Ignore storage write failures (private mode / quota)
  }
}
