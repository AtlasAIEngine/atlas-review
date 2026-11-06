export const DEFAULT_REVIEW_SYNC_SERVER_URL = ''; // Hosted sync is opt-in.

export const REVIEW_SYNC_SETTING_ENV_MAP = {
  review_sync_server_url: 'ATLAS_REVIEW_SYNC_SERVER_URL',
  review_sync_auth_token: 'ATLAS_REVIEW_SYNC_AUTH_TOKEN',
  review_sync_user_id: 'ATLAS_REVIEW_SYNC_USER_ID',
  review_sync_device_id: 'ATLAS_REVIEW_SYNC_DEVICE_ID',
  review_sync_device_label: 'ATLAS_REVIEW_SYNC_DEVICE_LABEL',
};

export const REVIEW_SYNC_SETTING_KEYS = Object.keys(REVIEW_SYNC_SETTING_ENV_MAP);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeReviewSyncSettingValue(key, value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;

  if (key === 'review_sync_server_url') {
    return normalized.replace(/\/+$/, '');
  }

  return normalized;
}

export function applyReviewSyncSettingToEnv(key, value, { override = true } = {}) {
  const envName = REVIEW_SYNC_SETTING_ENV_MAP[key];
  if (!envName) return false;
  if (!override && process.env[envName]) return false;

  const normalized = normalizeReviewSyncSettingValue(key, value);
  if (normalized) {
    process.env[envName] = normalized;
  } else {
    delete process.env[envName];
  }
  return true;
}

export function seedDefaultReviewSyncEnv({ override = false } = {}) {
  const envName = REVIEW_SYNC_SETTING_ENV_MAP.review_sync_server_url;
  if (!override && process.env[envName]) {
    return false;
  }
  if (!DEFAULT_REVIEW_SYNC_SERVER_URL) return false;
  process.env[envName] = DEFAULT_REVIEW_SYNC_SERVER_URL;
  return true;
}
