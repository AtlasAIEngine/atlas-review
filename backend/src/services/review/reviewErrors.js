/** Review Errors — Shared error types for review-service configuration and runtime issues. */

class SettingsReadError extends Error {
  constructor({
    settingKey,
    settingLabel,
    operation = 'read review settings',
    cause = null,
  } = {}) {
    const normalizedLabel = typeof settingLabel === 'string' && settingLabel.trim()
      ? settingLabel.trim()
      : 'review settings';
    const normalizedOperation = typeof operation === 'string' && operation.trim()
      ? operation.trim()
      : 'read review settings';
    const suffix = cause?.message ? `: ${cause.message}` : '';
    super(`Failed to ${normalizedOperation} for ${normalizedLabel}${suffix}`);
    this.name = 'SettingsReadError';
    this.runtimeCode = 'settings_read_failed';
    this.settingKey = typeof settingKey === 'string' ? settingKey.trim() : '';
    this.settingLabel = normalizedLabel;
    this.operation = normalizedOperation;
    if (cause) this.cause = cause;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, SettingsReadError);
    }
  }
}

function createSettingsReadError(options = {}) {
  return new SettingsReadError(options);
}

function isSettingsReadError(error) {
  return error instanceof SettingsReadError || error?.runtimeCode === 'settings_read_failed';
}

export {
  SettingsReadError,
  createSettingsReadError,
  isSettingsReadError,
};
