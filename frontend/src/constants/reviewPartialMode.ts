// Pre-flight popup threshold: above this file count, offer partial review.
// Mirror of backend PARTIAL_MODE_POPUP_THRESHOLD (env: ATLAS_REVIEW_PARTIAL_MODE_POPUP_THRESHOLD).
export const LARGE_DIFF_PARTIAL_POPUP_THRESHOLD = 100;

// User-facing hint for how many files partial mode covers.
// Mirror of backend PARTIAL_MODE_MAX_FILES (env: ATLAS_REVIEW_PARTIAL_MODE_MAX_FILES).
export const PARTIAL_MODE_MAX_FILES_HINT = 90;
