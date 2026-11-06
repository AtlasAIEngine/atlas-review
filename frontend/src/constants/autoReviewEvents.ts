export const AUTO_REVIEW_SETTING_CHANGED_EVENT = 'atlas-auto-review-setting-changed';

export type AutoReviewSettingChangedDetail = {
  enabled: boolean;
};

export function emitAutoReviewSettingChanged(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AutoReviewSettingChangedDetail>(
    AUTO_REVIEW_SETTING_CHANGED_EVENT,
    { detail: { enabled } },
  ));
}
