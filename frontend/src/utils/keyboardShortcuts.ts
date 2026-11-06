export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgentDataPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  const platform = userAgentDataPlatform || navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

type ShortcutPart = 'primary' | 'shift' | 'alt' | 'enter' | string;

interface FormatShortcutOptions {
  compact?: boolean;
}

const MODIFIER_ORDER = ['primary', 'shift', 'alt'] as const;
const APPLE_COMPACT_MODIFIER_ORDER = ['shift', 'primary', 'alt'] as const;

function normalizeShortcutPart(part: ShortcutPart): string {
  return String(part).toLowerCase();
}

function formatTextPart(part: ShortcutPart, apple: boolean): string {
  const normalized = normalizeShortcutPart(part);
  if (normalized === 'primary') return apple ? 'Cmd' : 'Ctrl';
  if (normalized === 'shift') return 'Shift';
  if (normalized === 'alt') return apple ? 'Option' : 'Alt';
  if (normalized === 'enter') return 'Enter';
  return String(part);
}

function formatAppleCompactPart(part: ShortcutPart): string {
  const normalized = normalizeShortcutPart(part);
  if (normalized === 'primary') return '⌘';
  if (normalized === 'shift') return '⇧';
  if (normalized === 'alt') return '⌥';
  if (normalized === 'enter') return '↵';
  return String(part);
}

export function formatShortcut(parts: ShortcutPart[], options: FormatShortcutOptions = {}): string {
  const apple = isApplePlatform();
  const normalizedParts = parts.map(normalizeShortcutPart);
  const modifiers = new Set(normalizedParts.filter((part) => MODIFIER_ORDER.includes(part as (typeof MODIFIER_ORDER)[number])));
  const regularParts = parts.filter((part) => !MODIFIER_ORDER.includes(normalizeShortcutPart(part) as (typeof MODIFIER_ORDER)[number]));

  if (options.compact && apple) {
    return [
      ...APPLE_COMPACT_MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)).map(formatAppleCompactPart),
      ...regularParts.map(formatAppleCompactPart),
    ].join('');
  }

  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)).map((part) => formatTextPart(part, apple)),
    ...regularParts.map((part) => formatTextPart(part, apple)),
  ].join('+');
}
