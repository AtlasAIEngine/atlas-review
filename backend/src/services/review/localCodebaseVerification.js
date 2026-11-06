import { verifyUnityFindingsAgainstLocalCodebase } from './unityLocalCodebaseVerification.js';

export const LOCAL_CODEBASE_VERIFICATION_TOOL_ID = 'review_local_codebase_verifier';

function emptyLocalVerificationResult(reason = null, findings = []) {
  return {
    findings,
    bundleEntries: [],
    providerId: null,
    stats: {
      enabled: false,
      skippedReason: reason,
      toolId: LOCAL_CODEBASE_VERIFICATION_TOOL_ID,
      verifiedCount: Array.isArray(findings) ? findings.length : 0,
      suppressedCount: 0,
      bundleEntryCount: 0,
      providerId: null,
    },
  };
}

const PROVIDERS = new Map([
  ['unity', verifyUnityFindingsAgainstLocalCodebase],
]);

export async function runReviewLocalCodebaseVerification(projectPath, findings = [], options = {}) {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedProjectPath) {
    return emptyLocalVerificationResult('project_unavailable', findings);
  }

  const reviewProfile = options.reviewProfile || null;
  const stackFamily = String(reviewProfile?.stackFamily || '').trim().toLowerCase();
  if (!stackFamily) {
    return emptyLocalVerificationResult('missing_stack_family', findings);
  }

  const provider = PROVIDERS.get(stackFamily);
  if (!provider) {
    return emptyLocalVerificationResult(`unsupported_stack:${stackFamily}`, findings);
  }

  const result = await provider(normalizedProjectPath, findings, options);
  const stats = result?.stats && typeof result.stats === 'object' ? result.stats : {};
  return {
    ...result,
    providerId: stackFamily,
    stats: {
      ...stats,
      toolId: stats.toolId || LOCAL_CODEBASE_VERIFICATION_TOOL_ID,
      bundleEntryCount: Array.isArray(result?.bundleEntries) ? result.bundleEntries.length : 0,
      providerId: stackFamily,
    },
  };
}
