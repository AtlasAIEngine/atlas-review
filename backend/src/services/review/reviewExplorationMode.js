/**
 * Performance review exploration-mode classifier and intended-mode resolver
 * (Milestone M1a — measurement only).
 *
 * Two pure functions, no I/O, no logging:
 *
 *   classifyExplorationMode({toolUseTelemetry, shapedScope, agenticStats})
 *     → 'none' | 'diff_only' | 'targeted_context' | 'broad_agentic' | null
 *
 *   resolveIntendedExplorationMode(strategy, signals)
 *     → { mode, reasonCodes[] } | null
 *
 * **M1a contract:** the resolver's output is metadata only. Nothing in the
 * agentic pipeline reads `explorationModeIntended` to gate behavior in this
 * milestone — the prompt builder, the tool surface, and model routing all
 * ignore it. M1b is what wires the intended mode to actual agent behavior.
 *
 * The four canonical modes follow the precedence order
 *   broad_agentic > targeted_context > diff_only > none
 * which the classifier implements as a "first match wins" cascade.
 */

// ---- classifier ------------------------------------------------------------

const BROAD_AGENTIC_THRESHOLDS = Object.freeze({
  // Repeated reads of the same file > this many means the agent kept
  // re-entering the same code path; that's broad reasoning, not targeted.
  repeatedReadsTotal: 5,
  // Unique files read > changedFiles + this many means the agent went
  // outside the diff scope into related code, which is broad exploration.
  uniqueFilesOverChangedFiles: 4,
  // Total non-full reads + greps > this many means heavy exploration even
  // if individually each is partial.
  combinedLookups: 12,
});

const DIFF_ONLY_UNIQUE_FILES_RATIO = 0.5;

// shell_heavy threshold (M1b). 5 was chosen because B3 Performance run-2 in
// the M1a repeats hit 21 shell calls and produced no usable exploration —
// any number ≥ 5 is comfortably above "ran one quick command" and into
// "decided to sweep with bash". Tunable as Unity / further data lands.
const SHELL_HEAVY_MIN_SHELL_CALLS = 5;

/**
 * Classify the *observed* exploration mode of an agentic review run from the
 * M0 telemetry.
 *
 * @param {object} input
 * @param {object|null} input.toolUseTelemetry - snapshot from
 *   reviewToolUseTelemetry.snapshot()
 * @param {object|null} [input.shapedScope] - shaped-scope telemetry from
 *   shapeReviewScopeForProfile; reads `.rawFileCount`
 * @param {object|null} [input.agenticStats] - the agenticReview stats block;
 *   reads `.agenticPreComputedDiff` and `.agenticActualTurns` (used as
 *   descriptive context, not gating logic)
 * @returns {string|null} canonical mode or null when telemetry is missing
 */
export function classifyExplorationMode(input = {}) {
  const tt = input?.toolUseTelemetry;
  if (!tt || typeof tt !== 'object') return null;

  const changedFiles = Math.max(
    0,
    Math.trunc(Number(input?.shapedScope?.rawFileCount) || 0),
  );

  const toolCalls = Math.max(0, Math.trunc(Number(tt.toolCalls) || 0));
  const fullFileReads = Math.max(0, Math.trunc(Number(tt.fullFileReads) || 0));
  const partialFileReads = Math.max(0, Math.trunc(Number(tt.partialFileReads) || 0));
  const gitDiffCalls = Math.max(0, Math.trunc(Number(tt.gitDiffCalls) || 0));
  const repeatedReadsTotal = Math.max(0, Math.trunc(Number(tt.repeatedReadsTotal) || 0));
  const uniqueFilesRead = Math.max(0, Math.trunc(Number(tt.uniqueFilesRead) || 0));
  const grepCalls = Math.max(
    0,
    Math.trunc(Number(tt.classifiedCounts?.grep) || 0),
  );

  // 1. No exploration at all → `none`. The agent emitted from the diff alone.
  if (toolCalls === 0) return 'none';

  // 2. Any signal of broad exploration → `broad_agentic`.
  if (fullFileReads > 0) return 'broad_agentic';
  if (gitDiffCalls > 0) return 'broad_agentic';
  if (repeatedReadsTotal > BROAD_AGENTIC_THRESHOLDS.repeatedReadsTotal) {
    return 'broad_agentic';
  }
  if (uniqueFilesRead > changedFiles + BROAD_AGENTIC_THRESHOLDS.uniqueFilesOverChangedFiles) {
    return 'broad_agentic';
  }
  const combinedLookups = partialFileReads + grepCalls;
  if (combinedLookups > BROAD_AGENTIC_THRESHOLDS.combinedLookups) {
    return 'broad_agentic';
  }

  // 3. shell_heavy (M1b). The agent burned the turn budget on `Bash` without
  // reading or grepping anything we recognize as exploration. M1a repeats
  // surfaced this on B3 Performance run-2 (21 shell calls, $4.11 cost,
  // classified `none` by the original 4-mode rule). Sits between
  // broad_agentic (which would have caught full reads / git diff / huge
  // sweeps) and the targeted/diff_only band. Edits and writes disqualify —
  // those are intentional code modifications, not exploration churn.
  const shellCalls = Math.max(
    0,
    Math.trunc(Number(tt.classifiedCounts?.shell) || 0),
  );
  const editCalls = Math.max(
    0,
    Math.trunc(Number(tt.classifiedCounts?.edit) || 0),
  );
  const writeCalls = Math.max(
    0,
    Math.trunc(Number(tt.classifiedCounts?.write) || 0),
  );
  if (
    combinedLookups === 0
    && shellCalls >= SHELL_HEAVY_MIN_SHELL_CALLS
    && editCalls === 0
    && writeCalls === 0
  ) {
    return 'shell_heavy';
  }

  // 4. Some lookups but bounded → `diff_only` if reads stayed within the
  // changed-files footprint, `targeted_context` if they reached out a bit.
  if (combinedLookups > 0) {
    const diffOnlyCap = Math.ceil(changedFiles * DIFF_ONLY_UNIQUE_FILES_RATIO);
    return uniqueFilesRead <= diffOnlyCap ? 'diff_only' : 'targeted_context';
  }

  // 5. Tool calls happened but they weren't reading, grepping, or shelling
  //    enough to warrant their own bucket. Treat as `none`.
  return 'none';
}

// ---- intended-mode resolver ------------------------------------------------

/**
 * Resolve the *intended* exploration mode for a Performance review run from
 * deterministic signals computed before the agent call.
 *
 * Returns `null` for any non-Performance strategy: this preserves the
 * Balanced contract — Balanced does not have an intended mode, the legacy
 * pipeline runs unchanged.
 *
 * Signals are best-effort. Under-detection in M1a is acceptable: the
 * observed mode is captured separately and reconciliation telemetry will
 * surface drift, which informs whether the resolver needs tightening
 * before M1b's enforcement step.
 *
 * Policy precedence (first match wins):
 *   high-risk escalation     → broad_agentic
 *   any targeted-context signal → targeted_context
 *   diff is doc/asset/config-only with no risk keywords → none
 *   default for code change  → diff_only
 *
 * @param {string|null|undefined} strategy
 * @param {object|null} signals
 * @returns {{mode: string, reasonCodes: string[]} | null}
 */
export function resolveIntendedExplorationMode(strategy, signals = null) {
  if (strategy !== 'performance') return null;
  const s = signals && typeof signals === 'object' ? signals : {};

  // 1. High-risk escalation: broad agent.
  if (s.hasHighRiskSignals) {
    return { mode: 'broad_agentic', reasonCodes: ['high_risk_signals'] };
  }
  if (s.touchesAuthOrStorage && s.largeBlastRadius) {
    return {
      mode: 'broad_agentic',
      reasonCodes: ['auth_or_storage', 'large_blast_radius'],
    };
  }

  // 2. Targeted-context signals — any one is enough to escalate from
  //    diff_only into targeted_context.
  const targetedReasons = [];
  if (Number(s.candidateFindingsCount) > 0) {
    targetedReasons.push('candidate_findings');
  }
  if (Number(s.linterFindingsCount) > 0) {
    targetedReasons.push('linter_findings');
  }
  if (s.hotspotsPresent) targetedReasons.push('hotspots');
  if (s.touchesPublicApi) targetedReasons.push('public_api');
  if (s.touchesAuthOrStorage) targetedReasons.push('auth_or_storage');
  if (s.touchesLifecycle) targetedReasons.push('lifecycle');
  if (s.touchesDependency) targetedReasons.push('dependency');
  if (s.touchesMigration) targetedReasons.push('migration');
  if (s.touchesRiskyConfig) targetedReasons.push('config_touched');
  if (targetedReasons.length > 0) {
    return { mode: 'targeted_context', reasonCodes: targetedReasons };
  }

  // 3. Doc/asset/pure-config-only with no risk keywords → none.
  const noneReasons = [];
  if (s.isDocOnly) noneReasons.push('doc_only');
  if (s.isAssetOnly) noneReasons.push('asset_only');
  if (s.isConfigOnly && !s.touchesRiskyConfig) {
    // pure config-only AND no risky config edits already flagged above
    noneReasons.push('config_only_no_risk');
  }
  if (noneReasons.length > 0 && !s.hasRiskKeywords) {
    return { mode: 'none', reasonCodes: noneReasons };
  }

  // 4. Default for code changes: diff_only.
  return { mode: 'diff_only', reasonCodes: ['low_medium_risk_code_change'] };
}

// ---- signal extraction -----------------------------------------------------

const DOC_PATH_RE = /(^|\/)(docs?|documentation)\//i;
const DOC_EXT_RE = /\.(md|mdx|markdown|rst|txt|adoc|asciidoc)$/i;
const ASSET_EXT_RE = /\.(png|jpe?g|svg|webp|gif|ico|woff2?|ttf|otf|eot|mp[34]|webm|mov|pdf|psd|sketch|fig)$/i;
const ASSET_PATH_RE = /(^|\/)(assets?|images?|media|fonts|icons?|public|static)\//i;

const CONFIG_EXT_RE = /\.(json|jsonc|json5|yaml|yml|toml|ini|env)(\.template|\.example|\.sample)?$/i;
const CONFIG_PATH_RE = /(^|\/)(\.env(\..*)?|tsconfig\.json|jsconfig\.json|babel\.config|vite\.config|webpack\.config|rollup\.config|jest\.config|vitest\.config|next\.config|nuxt\.config|tailwind\.config|postcss\.config|\.eslintrc|\.prettierrc|\.editorconfig)$/i;
const CONFIG_FILE_RE = /\.(config)\.(js|ts|cjs|mjs|json)$/i;
const RISKY_CONFIG_PATH_RE = /(^|\/)(\.env(\..*)?|auth\.config|oauth\.config|security\.config|database\.config|db\.config|storage\.config|secrets?\.|credentials?\.|firebase\.json|supabase\/config\.toml)/i;

const DEPENDENCY_PATH_RE = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|.+\.csproj|.+\.fsproj|.+\.vbproj|composer\.(json|lock)|Pipfile(\.lock)?|poetry\.lock|pubspec\.(yaml|lock))$/i;

const MIGRATION_PATH_RE = /(^|\/)(migrations?|migrate|db\/migrations?|prisma\/migrations?|alembic\/versions?|knex\/migrations?)\//i;
const SQL_EXT_RE = /\.sql$/i;

const PUBLIC_API_PATH_RE = /(^|\/)(routes?|api|controllers?|handlers?|endpoints?|graphql|grpc)\//i;
const PROTO_GRAPHQL_RE = /\.(proto|graphql|gql)$/i;
const OPENAPI_RE = /(openapi|swagger)\.(ya?ml|json)$/i;

// Match auth/storage keywords as either standalone tokens OR prefixes of
// camelCase / snake_case identifiers (`authService`, `authentication`,
// `database_url`). Trailing separator NOT required — over-detection in M1a
// is preferable to under-detection since the worst case is intended mode
// nudges toward targeted_context (observed mode will reveal).
const AUTH_OR_STORAGE_PATH_RE = /(^|\/|[._-])(auth|oauth|jwt|session|crypto|cipher|secret|credential|password|token|api[-_]?key|database|datastore|storage|store|repository|persistence|migration)/i;

const LIFECYCLE_PATH_RE = /(lifecycle|on(?:Enable|Disable|Destroy|Mount|Unmount|Start|Stop|Awake)|componentDid(?:Mount|Update|Unmount)|use(?:Effect|LayoutEffect))/i;

const RISK_KEYWORD_RE = /(auth|password|secret|token|crypto|security|payment|stripe|webhook|signature|encrypt|decrypt|hash|priv(?:ate|key)|race|deadlock|mutex|atomic|lock|concurrency)/i;

function classifyFilePath(path) {
  const p = String(path || '').toLowerCase();
  if (!p) return { kind: 'unknown' };
  if (ASSET_EXT_RE.test(p) || ASSET_PATH_RE.test(p)) return { kind: 'asset' };
  if (DOC_EXT_RE.test(p) || DOC_PATH_RE.test(p)) return { kind: 'doc' };
  if (DEPENDENCY_PATH_RE.test(p)) return { kind: 'dependency' };
  if (MIGRATION_PATH_RE.test(p) || SQL_EXT_RE.test(p)) return { kind: 'migration' };
  if (CONFIG_PATH_RE.test(p) || CONFIG_FILE_RE.test(p) || CONFIG_EXT_RE.test(p)) return { kind: 'config' };
  return { kind: 'code' };
}

/**
 * Extract intended-mode signals from the data already computed before the
 * agentic call. Best-effort: under-detection is acceptable in M1a since the
 * observed-mode classifier and reconciliation telemetry will surface drift.
 *
 * @param {object} ctx
 * @param {Array<{path?: string}>} [ctx.fileHints]
 * @param {Array<object>} [ctx.linterFindings]
 * @param {{summary?: string}} [ctx.behavioralHotspots]
 * @param {boolean} [ctx.largeBlastRadius]
 * @param {number} [ctx.candidateFindingsCount]
 * @returns {object} signals POJO consumable by resolveIntendedExplorationMode
 */
export function buildIntendedExplorationModeSignals(ctx = {}) {
  const fileHints = Array.isArray(ctx.fileHints) ? ctx.fileHints : [];
  const linterFindings = Array.isArray(ctx.linterFindings) ? ctx.linterFindings : [];
  const paths = fileHints.map((h) => String(h?.path || '')).filter(Boolean);
  const classifications = paths.map(classifyFilePath);

  let docCount = 0;
  let assetCount = 0;
  let configCount = 0;
  let codeCount = 0;
  let touchesDependency = false;
  let touchesMigration = false;
  let touchesPublicApi = false;
  let touchesAuthOrStorage = false;
  let touchesLifecycle = false;
  let touchesConfig = false;
  let touchesRiskyConfig = false;
  let hasRiskKeywords = false;

  for (let i = 0; i < paths.length; i += 1) {
    const p = paths[i];
    const k = classifications[i].kind;
    if (k === 'doc') docCount += 1;
    else if (k === 'asset') assetCount += 1;
    else if (k === 'config') {
      configCount += 1;
      touchesConfig = true;
      if (RISKY_CONFIG_PATH_RE.test(p) || AUTH_OR_STORAGE_PATH_RE.test(p) || RISK_KEYWORD_RE.test(p)) {
        touchesRiskyConfig = true;
      }
    }
    else if (k === 'dependency') touchesDependency = true;
    else if (k === 'migration') { touchesMigration = true; touchesAuthOrStorage = true; }
    else codeCount += 1;

    if (PUBLIC_API_PATH_RE.test(p) || PROTO_GRAPHQL_RE.test(p) || OPENAPI_RE.test(p)) {
      touchesPublicApi = true;
    }
    if (AUTH_OR_STORAGE_PATH_RE.test(p)) touchesAuthOrStorage = true;
    if (LIFECYCLE_PATH_RE.test(p)) touchesLifecycle = true;
    if (RISK_KEYWORD_RE.test(p)) hasRiskKeywords = true;
  }

  const totalFiles = paths.length;
  const isDocOnly = totalFiles > 0 && docCount === totalFiles;
  const isAssetOnly = totalFiles > 0 && assetCount === totalFiles;
  const isConfigOnly = totalFiles > 0 && (configCount + docCount + assetCount) === totalFiles && configCount > 0;

  const linterFindingsCount = linterFindings.length;
  const hotspotsPresent = Boolean(
    ctx.behavioralHotspots
      && typeof ctx.behavioralHotspots.summary === 'string'
      && ctx.behavioralHotspots.summary.trim().length > 0,
  );
  const candidateFindingsCount = Math.max(
    0,
    Math.trunc(Number(ctx.candidateFindingsCount) || 0),
  );
  const largeBlastRadius = Boolean(ctx.largeBlastRadius);

  // High-risk: explicit caller flag, or a critical/high linter finding.
  const linterHasCritical = linterFindings.some((f) => {
    const sev = String(f?.severity || f?.level || '').toLowerCase();
    return sev === 'critical' || sev === 'high';
  });
  const hasHighRiskSignals = Boolean(ctx.hasHighRiskSignals) || linterHasCritical;

  return {
    isDocOnly,
    isAssetOnly,
    isConfigOnly,
    hasRiskKeywords,
    candidateFindingsCount,
    linterFindingsCount,
    hotspotsPresent,
    touchesPublicApi,
    touchesAuthOrStorage,
    touchesLifecycle,
    touchesDependency,
    touchesMigration,
    touchesConfig,
    touchesRiskyConfig,
    largeBlastRadius,
    hasHighRiskSignals,
  };
}

// ---- reconciliation --------------------------------------------------------

/**
 * Compare intended and observed exploration modes. Used after every
 * Performance run that emits both fields.
 *
 * @returns {{
 *   reconciled: boolean,
 *   drift: {intended: string, observed: string} | null
 * }}
 */
export function reconcileExplorationMode(intended, observed) {
  const reconciled = intended != null && observed != null && intended === observed;
  if (reconciled) return { reconciled: true, drift: null };
  return {
    reconciled: false,
    drift: intended != null && observed != null
      ? { intended, observed }
      : null,
  };
}

export const __testables = {
  BROAD_AGENTIC_THRESHOLDS,
  DIFF_ONLY_UNIQUE_FILES_RATIO,
  SHELL_HEAVY_MIN_SHELL_CALLS,
};
