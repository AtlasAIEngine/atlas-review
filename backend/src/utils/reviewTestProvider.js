const REVIEW_TEST_PROVIDER_FLAG = 'ATLAS_REVIEW_TEST_PROVIDER';
const REVIEW_TEST_PROVIDER_ENABLED_VALUE = '1';
const REVIEW_TEST_PROVIDER_ALLOWED_ENVS = new Set(['test', 'ci']);

let warnedAboutIgnoredStubEnv = false;

export function isReviewTestProviderEnabled() {
  const enabled = process.env[REVIEW_TEST_PROVIDER_FLAG] === REVIEW_TEST_PROVIDER_ENABLED_VALUE;
  if (!enabled) return false;

  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (!REVIEW_TEST_PROVIDER_ALLOWED_ENVS.has(nodeEnv)) {
    if (!warnedAboutIgnoredStubEnv) {
      warnedAboutIgnoredStubEnv = true;
      console.error(
        `[ReviewTestProvider] Ignoring ${REVIEW_TEST_PROVIDER_FLAG}=1 in ${nodeEnv || 'unknown'} environment.`
      );
    }
    return false;
  }

  return true;
}

export {
  REVIEW_TEST_PROVIDER_FLAG,
  REVIEW_TEST_PROVIDER_ENABLED_VALUE,
  REVIEW_TEST_PROVIDER_ALLOWED_ENVS,
};
