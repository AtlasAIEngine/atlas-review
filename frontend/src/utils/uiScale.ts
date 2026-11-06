/**
 * UI Font Scale
 *
 * Scales ALL text (both CSS variable tokens and hardcoded inline px sizes)
 * without affecting layout, spacing, icons, or panel sizes.
 *
 * Strategy:
 * 1. Override --text-* CSS design tokens (covers ~60% of text)
 * 2. Use a MutationObserver to intercept inline fontSize on new/changed elements
 * 3. Store original px values as data attributes to allow re-scaling
 */

const BASE_SIZES: Record<string, number> = {
  '--text-xs': 11,
  '--text-sm': 12,
  '--text-md': 13,
  '--text-lg': 15,
  '--text-xl': 20,
  '--text-2xl': 28,
};

let currentScale = 1;
let observer: MutationObserver | null = null;
let isScaling = false;

function scaleElement(el: HTMLElement): void {
  const inlineSize = el.style.fontSize;
  if (!inlineSize || !inlineSize.endsWith('px')) return;

  // Store or update original size
  const storedOrig = el.dataset.origFontSize;
  if (storedOrig) {
    // Detect if React changed the inline fontSize to a new base value
    const expectedScaled = Math.round(parseInt(storedOrig, 10) * currentScale);
    if (Math.abs(parseInt(inlineSize, 10) - expectedScaled) > 1) {
      el.dataset.origFontSize = inlineSize;
    }
  } else {
    el.dataset.origFontSize = inlineSize;
  }

  const original = parseInt(el.dataset.origFontSize!, 10);
  if (!Number.isFinite(original) || original <= 0) return;

  const scaled = Math.round(original * currentScale);
  if (scaled !== parseInt(inlineSize, 10)) {
    isScaling = true;
    el.style.fontSize = `${scaled}px`;
    isScaling = false;
  }
}

function scanTree(root: Node): void {
  if (currentScale === 1) return;
  if (root instanceof HTMLElement) {
    if (root.style.fontSize) scaleElement(root);
    const children = root.querySelectorAll<HTMLElement>('[style]');
    for (const child of children) {
      if (child.style.fontSize) scaleElement(child);
    }
  }
}

function startObserver(): void {
  if (observer) return;
  const target = document.getElementById('root');
  if (!target) return;

  observer = new MutationObserver((mutations) => {
    if (isScaling) return;
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          scanTree(node);
        }
      } else if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
        if (mutation.target.style.fontSize) {
          scaleElement(mutation.target);
        }
      }
    }
  });

  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  });
}

function stopObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

/**
 * Apply a font scale percentage (e.g. 110 = 110%).
 * Scales all text — CSS variables AND hardcoded inline font sizes.
 */
export function applyFontScale(percent: number): void {
  const scale = (Number.isFinite(percent) && percent > 0) ? percent / 100 : 1;
  currentScale = scale;
  const root = document.documentElement;

  // 1. Scale CSS variable tokens
  if (scale === 1) {
    for (const token of Object.keys(BASE_SIZES)) {
      root.style.removeProperty(token);
    }
  } else {
    for (const [token, base] of Object.entries(BASE_SIZES)) {
      root.style.setProperty(token, `${Math.round(base * scale)}px`);
    }
  }

  // 2. Scale existing inline font sizes
  const appRoot = document.getElementById('root');
  if (appRoot) {
    if (scale === 1) {
      // Restore original sizes
      const scaled = appRoot.querySelectorAll<HTMLElement>('[data-orig-font-size]');
      for (const el of scaled) {
        el.style.fontSize = el.dataset.origFontSize!;
        delete el.dataset.origFontSize;
      }
      stopObserver();
    } else {
      const elements = appRoot.querySelectorAll<HTMLElement>('[style]');
      for (const el of elements) {
        if (el.style.fontSize) scaleElement(el);
      }
      // 3. Watch for future React renders
      startObserver();
    }
  }
}
