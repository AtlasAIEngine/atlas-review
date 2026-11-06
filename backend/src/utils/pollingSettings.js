export const GIT_POLL_INTERVAL_OPTIONS = Object.freeze(['2', '5', '10', '30', 'manual']);
export const PR_AUTO_REFRESH_INTERVAL_OPTIONS = Object.freeze(['30', '60', '300', 'manual']);

export const DEFAULT_GIT_POLL_INTERVAL = '5';
export const DEFAULT_PR_AUTO_REFRESH_ENABLED = false;
export const DEFAULT_PR_AUTO_REFRESH_INTERVAL = 'manual';

function normalizeStringValue(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeBooleanSetting(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeStringValue(value);
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function normalizePollIntervalSetting(value, allowedValues, fallback) {
  const normalized = normalizeStringValue(value);
  return allowedValues.includes(normalized) ? normalized : fallback;
}

export function pollIntervalSettingToMs(value, allowedValues, fallback) {
  const normalized = normalizePollIntervalSetting(value, allowedValues, fallback);
  if (normalized === 'manual') return null;
  return Number(normalized) * 1000;
}
