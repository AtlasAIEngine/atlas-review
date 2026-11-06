/** Review File Selection — File scoring, selection, budget allocation, and chunking. */

import { createHash } from 'crypto';
import { structuredPatch } from 'diff';
import {
  FOCUSED_REVIEW_TRIGGER_FILE_COUNT,
  FOCUSED_REVIEW_MAX_DEEP_FILES,
  FOCUSED_REVIEW_MIN_DEEP_FILES,
  FOCUSED_REVIEW_TRIGGER_DIFF_CHARS,
  FOCUSED_REVIEW_TARGET_DIFF_CHARS,
  FOCUSED_REVIEW_EXPANSION_TARGET_MULTIPLIER,
  FOCUSED_REVIEW_ADAPTIVE_MAX_DEEP_FILES,
  FOCUSED_REVIEW_ADAPTIVE_MIN_TRIGGER_FILE_COUNT,
  FOCUSED_REVIEW_ADAPTIVE_MIN_TRIGGER_DIFF_CHARS,
  REVIEW_CHUNK_CHAR_LIMIT,
  REVIEW_MAX_CHUNKS,
  REVIEW_OMITTED_FILE_PROMPT_LIMIT,
  REVIEW_TOTAL_DEADLINE_MS,
  REVIEW_FILE_CACHE_PROMPT_VERSION,
  DOC_FILE_RE,
  TEST_FILE_RE,
} from './reviewConstants.js';
import {
  clampNumber,
  normalizePathForMatch,
  hashReviewFileContent,
  resolveReviewQualityMode,
} from './reviewHelpers.js';
import {
  isHighRiskReviewFile,
  CODE_FILE_RE,
  CONFIG_FILE_RE,
  HIGH_RISK_RE,
} from './reviewIgnorePatterns.js';
import {
  getReviewProfileById,
} from './reviewProjectProfileService.js';

// ── Deadline / Provider Utilities ────────────────────────────────────────────

function resolveDeadlinePressure(deadline = null) {
  const remainingMs = deadline && typeof deadline.remainingMs === 'function'
    ? Math.max(0, Number(deadline.remainingMs()) || 0)
    : REVIEW_TOTAL_DEADLINE_MS;
  const ratio = clampNumber(
    REVIEW_TOTAL_DEADLINE_MS > 0
      ? remainingMs / REVIEW_TOTAL_DEADLINE_MS
      : 1,
    0.1,
    1.5
  );
  return { remainingMs, ratio };
}

function resolveReviewPromptVersionForCache(qualityMode) {
  const normalizedQualityMode = resolveReviewQualityMode(qualityMode);
  return `${REVIEW_FILE_CACHE_PROMPT_VERSION}:${normalizedQualityMode}`;
}

function buildReviewFileCacheDescriptor({
  contextType,
  file,
  providerType,
  providerModel,
  effectiveStrategy = null,
  qualityMode,
  promptVersion = null,
}) {
  const normalizedContextType = typeof contextType === 'string' && contextType.trim()
    ? contextType.trim()
    : 'unknown';
  const filePath = normalizePathForMatch(file?.path || '');
  const beforeHash = hashReviewFileContent(file?.before);
  const afterHash = hashReviewFileContent(file?.after);
  const resolvedProviderType = typeof providerType === 'string' && providerType.trim()
    ? providerType.trim()
    : 'unknown';
  const resolvedProviderModel = typeof providerModel === 'string' && providerModel.trim()
    ? providerModel.trim()
    : 'unknown';
  const resolvedEffectiveStrategy = typeof effectiveStrategy === 'string' && effectiveStrategy.trim()
    ? effectiveStrategy.trim()
    : 'unknown';
  const resolvedQualityMode = resolveReviewQualityMode(qualityMode);
  const resolvedPromptVersion = String(
    promptVersion && String(promptVersion).trim()
      ? promptVersion
      : resolveReviewPromptVersionForCache(resolvedQualityMode)
  ).trim();
  const cacheMaterial = [
    normalizedContextType,
    filePath,
    beforeHash,
    afterHash,
    resolvedProviderType,
    resolvedProviderModel,
    resolvedEffectiveStrategy,
    resolvedPromptVersion,
  ].join('\u001f');
  const cacheKey = createHash('sha256').update(cacheMaterial, 'utf8').digest('hex');
  return {
    contextType: normalizedContextType,
    cacheKey,
    filePath,
    beforeHash,
    afterHash,
    providerType: resolvedProviderType,
    providerModel: resolvedProviderModel,
    effectiveStrategy: resolvedEffectiveStrategy,
    promptVersion: resolvedPromptVersion,
    qualityMode: resolvedQualityMode,
  };
}

function getProviderCandidatesInPreferredOrder(providerFailoverState, fallbackProvider = null) {
  const candidates = Array.isArray(providerFailoverState?.candidates)
    ? providerFailoverState.candidates.filter((entry) => entry && entry.provider)
    : [];
  if (candidates.length === 0) {
    return fallbackProvider ? [fallbackProvider] : [];
  }

  const preferredIndex = Math.max(
    0,
    Math.min(candidates.length - 1, Number(providerFailoverState?.preferredIndex) || 0)
  );
  const ordered = [];
  for (let i = preferredIndex; i < candidates.length; i += 1) ordered.push(candidates[i]);
  for (let i = 0; i < preferredIndex; i += 1) ordered.push(candidates[i]);
  if (fallbackProvider && !ordered.includes(fallbackProvider)) {
    ordered.push(fallbackProvider);
  }
  return ordered;
}

function isValidCachedPerFileReview(review) {
  return !!(
    review &&
    typeof review === 'object' &&
    typeof review.summary === 'string' &&
    typeof review.riskLevel === 'string' &&
    Array.isArray(review.changeGroups) &&
    Array.isArray(review.recommendations)
  );
}

// ── Size Estimation ──────────────────────────────────────────────────────────

function estimateModifiedPatchChars(beforeContent, afterContent) {
  if (typeof beforeContent !== 'string' || typeof afterContent !== 'string') return 0;
  if (beforeContent === afterContent) return 0;
  try {
    const patch = structuredPatch(
      'a/file',
      'b/file',
      beforeContent,
      afterContent,
      '',
      '',
      { context: 0 }
    );
    const hunks = Array.isArray(patch?.hunks) ? patch.hunks : [];
    if (hunks.length === 0) return 0;
    let total = 0;
    for (const hunk of hunks) {
      total += 48; // hunk header + metadata overhead
      const lines = Array.isArray(hunk?.lines) ? hunk.lines : [];
      for (const line of lines) {
        total += String(line || '').length + 1;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function estimateFileReviewSize(file) {
  if (!file || typeof file !== 'object') return 0;
  if (Number.isFinite(Number(file._atlasReviewSizeEstimate)) && Number(file._atlasReviewSizeEstimate) > 0) {
    return Number(file._atlasReviewSizeEstimate);
  }

  const pathLen = String(file.path || '').length;
  const oldPathLen = String(file.oldPath || '').length;
  const baseOverhead = 96 + pathLen + oldPathLen;
  const hintedEstimate = Number(file.estimatedReviewSize ?? file.reviewSizeHint ?? file.diffCharsEstimate);
  if (Number.isFinite(hintedEstimate) && hintedEstimate > 0) {
    const normalizedHint = Math.max(baseOverhead, Math.trunc(hintedEstimate));
    if (Object.isExtensible(file)) {
      file._atlasReviewSizeEstimate = normalizedHint;
    }
    return normalizedHint;
  }

  const beforeLen = typeof file.before === 'string' ? file.before.length : 0;
  const afterLen = typeof file.after === 'string' ? file.after.length : 0;
  let estimate = baseOverhead + beforeLen + afterLen;

  if (typeof file.before === 'string' && typeof file.after === 'string') {
    const patchChars = estimateModifiedPatchChars(file.before, file.after);
    if (patchChars > 0) {
      // Approximate structured diff with context headers while staying much
      // closer to true changed surface area than full-file before/after size.
      estimate = baseOverhead + Math.max(120, Math.round(patchChars * 1.35));
    } else if (file.before === file.after) {
      // Pure rename/mode metadata style entries should not consume deep budget.
      estimate = baseOverhead + 128;
    }
  } else if (typeof file.before === 'string' && file.after == null) {
    estimate = baseOverhead + Math.max(120, Math.round(beforeLen * 1.05) + 96);
  } else if (typeof file.after === 'string' && file.before == null) {
    estimate = baseOverhead + Math.max(120, Math.round(afterLen * 1.05) + 96);
  }

  if (Object.isExtensible(file)) {
    file._atlasReviewSizeEstimate = estimate;
  }
  return estimate;
}

function buildDiffStatMap(diffStatsFiles = []) {
  const map = new Map();
  if (!Array.isArray(diffStatsFiles)) return map;
  for (const stat of diffStatsFiles) {
    const pathKey = normalizePathForMatch(stat?.path);
    if (!pathKey) continue;
    map.set(pathKey, stat);
  }
  return map;
}

function estimateReviewSizeHintFromDiffStat(entry, diffStatMap = null) {
  const pathKey = normalizePathForMatch(entry?.path);
  const oldPathKey = normalizePathForMatch(entry?.oldPath);
  const stat = diffStatMap instanceof Map
    ? (diffStatMap.get(pathKey) || (oldPathKey ? diffStatMap.get(oldPathKey) : null))
    : null;

  const additions = Math.max(0, Number(stat?.additions || 0));
  const deletions = Math.max(0, Number(stat?.deletions || 0));
  const lineDelta = additions + deletions;
  const pathLen = String(entry?.path || '').length;
  const oldPathLen = String(entry?.oldPath || '').length;
  const baseOverhead = 96 + pathLen + oldPathLen;
  if (lineDelta > 0) {
    return baseOverhead + Math.round(lineDelta * 90) + 64;
  }

  const status = String(entry?.status || '').toUpperCase();
  if (status === 'A' || status === 'D') {
    return baseOverhead + 12000;
  }
  return baseOverhead + 3000;
}

// ── Scoring & Prioritization ─────────────────────────────────────────────────

function resolveProfileClassification(entry, reviewProfile = null, context = {}) {
  const safeProfile = reviewProfile || getReviewProfileById('generic');
  if (!safeProfile || typeof safeProfile.classifyEntry !== 'function') {
    return {
      fileClass: entry?.profileClass || 'shallow',
      reason: 'profile_unavailable',
      pairWithSiblingMeta: false,
      riskBoost: 0,
      sizeMultiplier: 1,
    };
  }
  const classified = safeProfile.classifyEntry(entry, context);
  return {
    fileClass: typeof classified?.fileClass === 'string' ? classified.fileClass : (entry?.profileClass || 'shallow'),
    reason: typeof classified?.reason === 'string' ? classified.reason : 'profile_default',
    pairWithSiblingMeta: classified?.pairWithSiblingMeta === true,
    riskBoost: Number.isFinite(Number(classified?.riskBoost)) ? Number(classified.riskBoost) : 0,
    sizeMultiplier: Number.isFinite(Number(classified?.sizeMultiplier)) ? Number(classified.sizeMultiplier) : 1,
  };
}

function computeShapedReviewSize(primaryEntry, memberEntries, diffStatMap, classification) {
  const members = Array.isArray(memberEntries) && memberEntries.length > 0
    ? memberEntries
    : [primaryEntry];
  const primaryHint = Number(primaryEntry?.reviewSizeHint);
  const primaryBase = Number.isFinite(primaryHint) && primaryHint > 0
    ? primaryHint
    : estimateReviewSizeHintFromDiffStat(primaryEntry, diffStatMap);
  let shapedSize = Math.max(120, primaryBase);

  for (let index = 1; index < members.length; index += 1) {
    const member = members[index];
    const rawHint = Number(member?.reviewSizeHint);
    const memberBase = Number.isFinite(rawHint) && rawHint > 0
      ? rawHint
      : estimateReviewSizeHintFromDiffStat(member, diffStatMap);
    shapedSize += Math.max(48, Math.round(memberBase * 0.1));
  }

  const multiplier = Number.isFinite(Number(classification?.sizeMultiplier))
    ? Number(classification.sizeMultiplier)
    : 1;
  return Math.max(96, Math.round(shapedSize * multiplier));
}

function shapeReviewScopeForProfile(entries, {
  reviewProfile = null,
  diffStatMap = null,
} = {}) {
  const safeEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const safeProfile = reviewProfile || getReviewProfileById('generic');
  const allPaths = new Set(
    safeEntries
      .map((entry) => normalizePathForMatch(entry?.path))
      .filter(Boolean)
  );
  const entryByPath = new Map(
    safeEntries
      .map((entry) => [normalizePathForMatch(entry?.path), entry])
      .filter(([path]) => !!path)
  );
  const consumedPaths = new Set();
  const classCounts = {
    deep: 0,
    structural: 0,
    shallow: 0,
    collapsed: 0,
    skip: 0,
  };
  const reviewUnits = [];
  let pairedFiles = 0;

  for (const entry of safeEntries) {
    const normalizedPath = normalizePathForMatch(entry?.path);
    if (!normalizedPath || consumedPaths.has(normalizedPath)) continue;
    const classification = resolveProfileClassification(entry, safeProfile, { allPaths });
    const className = classification.fileClass;

    if (className === 'skip') {
      classCounts.skip += 1;
      consumedPaths.add(normalizedPath);
      continue;
    }

    if (className === 'collapsed') {
      classCounts.collapsed += 1;
      consumedPaths.add(normalizedPath);
      continue;
    }

    const memberEntries = [entry];
    consumedPaths.add(normalizedPath);

    if (classification.pairWithSiblingMeta) {
      const siblingMetaPath = `${normalizedPath}.meta`;
      const siblingMeta = entryByPath.get(siblingMetaPath);
      if (siblingMeta && !consumedPaths.has(siblingMetaPath)) {
        memberEntries.push(siblingMeta);
        consumedPaths.add(siblingMetaPath);
        classCounts.collapsed += 1;
        pairedFiles += 1;
      }
    }

    if (className in classCounts) {
      classCounts[className] += 1;
    }

    const reviewSizeHint = computeShapedReviewSize(entry, memberEntries, diffStatMap, classification);
    reviewUnits.push({
      ...entry,
      profileClass: className,
      shapingReason: classification.reason,
      memberPaths: memberEntries.map((member) => member.path),
      memberStatuses: memberEntries.map((member) => member.status || 'M'),
      pairedMetaPath: memberEntries.length > 1 ? memberEntries[1]?.path || null : null,
      reviewSizeHint,
      estimatedSize: reviewSizeHint,
      rawFileCount: memberEntries.length,
    });
  }

  return {
    reviewUnits,
    telemetry: {
      profileId: safeProfile.id,
      rawFileCount: safeEntries.length,
      reviewUnitCount: reviewUnits.length,
      pairedFiles,
      classCounts,
    },
  };
}

function scoreNameStatusEntry(entry, options = {}) {
  const targetPath = normalizePathForMatch(entry.path || '');
  const oldPath = normalizePathForMatch(entry.oldPath || '');
  const candidate = `${targetPath} ${oldPath}`.trim();
  const classification = resolveProfileClassification(entry, options.reviewProfile);

  let score = 0;
  if (HIGH_RISK_RE.test(candidate)) score += 500;
  if (CODE_FILE_RE.test(targetPath)) score += 220;
  if (CONFIG_FILE_RE.test(candidate)) score += 120;
  if (DOC_FILE_RE.test(targetPath)) score += 70;
  if (TEST_FILE_RE.test(candidate)) score += 60;
  if (classification.fileClass === 'deep') score += 260;
  if (classification.fileClass === 'structural') score += 170;
  if (classification.fileClass === 'shallow') score += 30;
  if (classification.fileClass === 'collapsed') score -= 120;
  if (classification.fileClass === 'skip') score -= 500;
  score += classification.riskBoost;

  if (entry.status === 'R') score += 25;
  if (entry.status === 'D') score -= 10;

  return score;
}

function prioritizeNameStatusEntries(entries, options = {}) {
  return [...entries].sort((a, b) => {
    const scoreDiff = scoreNameStatusEntry(b, options) - scoreNameStatusEntry(a, options);
    if (scoreDiff !== 0) return scoreDiff;
    return String(a.path || '').localeCompare(String(b.path || ''));
  });
}

function summarizeOmittedFilesForPrompt(files, max = REVIEW_OMITTED_FILE_PROMPT_LIMIT, options = {}) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const normalizedEntries = files.map((file) => ({
    path: file.path,
    oldPath: file.oldPath || null,
    status: file.status || 'M',
    profileClass: file.profileClass || null,
  }));
  const ranked = prioritizeNameStatusEntries(normalizedEntries, options).slice(0, Math.max(1, Number(max) || 1));
  return ranked
    .map((entry) => {
      const normalizedPath = normalizePathForMatch(entry.path);
      if (!normalizedPath) return null;
      const status = String(entry.status || 'M').toUpperCase();
      const classLabel = typeof entry.profileClass === 'string' && entry.profileClass.trim()
        ? ` [${entry.profileClass.trim()}]`
        : '';
      return `${status} ${normalizedPath}${classLabel}`;
    })
    .filter(Boolean);
}

// ── Budget Configuration ─────────────────────────────────────────────────────

function deriveFocusedReviewBudgetConfig({
  files = [],
  providerData = null,
  reviewResolution = null,
  deadline = null,
  resolveProviderProfile = null,
} = {}) {
  const safeFiles = Array.isArray(files) ? files : [];
  const totalFiles = safeFiles.length;
  const estimatedTotalChars = safeFiles.reduce((acc, file) => acc + estimateFileReviewSize(file), 0);
  const highRiskCount = safeFiles.reduce((count, file) => count + (isHighRiskReviewFile(file) ? 1 : 0), 0);
  const highRiskRatio = totalFiles > 0 ? (highRiskCount / totalFiles) : 0;

  const providerProfile = typeof resolveProviderProfile === 'function'
    ? resolveProviderProfile(providerData)
    : {
      coverageMultiplier: 1,
      chunkConcurrencyBias: 1,
      perFileConcurrencyBias: 1,
      focusedTriggerFileCountBias: 1,
      focusedTriggerDiffBias: 1,
    };
  const deadlinePressure = resolveDeadlinePressure(deadline);
  const budgetClass = String(reviewResolution?.budgetClass || 'balanced').toLowerCase();
  const strategyMultiplier = budgetClass === 'quality'
    ? 1.22
    : budgetClass === 'latency'
      ? 0.9
      : budgetClass === 'custom'
        ? 1.06
        : 1.0;
  const sizeMultiplier = totalFiles >= 120 || estimatedTotalChars >= 1500000
    ? 1.58
    : totalFiles >= 80 || estimatedTotalChars >= 850000
      ? 1.42
      : totalFiles >= 40 || estimatedTotalChars >= 350000
        ? 1.24
        : totalFiles >= 20 || estimatedTotalChars >= 120000
          ? 1.08
          : 1.0;
  const riskMultiplier = 1 + Math.min(0.62, highRiskRatio * 0.8);
  const deadlineMultiplier = deadlinePressure.ratio >= 0.95
    ? 1.12
    : deadlinePressure.ratio >= 0.7
      ? 1.0
      : deadlinePressure.ratio >= 0.45
        ? 0.9
        : 0.78;
  const multiplier = clampNumber(
    sizeMultiplier * riskMultiplier * strategyMultiplier * providerProfile.coverageMultiplier * deadlineMultiplier,
    0.7,
    2.4
  );

  const baseMin = FOCUSED_REVIEW_MIN_DEEP_FILES;
  const baseMax = FOCUSED_REVIEW_MAX_DEEP_FILES;
  const baseTarget = FOCUSED_REVIEW_TARGET_DIFF_CHARS;
  const adaptiveMin = Math.max(
    1,
    Math.min(totalFiles || 1, Math.round(baseMin * multiplier))
  );
  const riskFloor = Math.min(
    totalFiles || adaptiveMin,
    Math.max(adaptiveMin, highRiskCount + Math.ceil(highRiskCount * 0.25))
  );
  const adaptiveMax = Math.max(
    riskFloor,
    Math.min(
      totalFiles || riskFloor,
      Math.round(
        Math.max(baseMax, FOCUSED_REVIEW_ADAPTIVE_MAX_DEEP_FILES)
          * clampNumber(multiplier * 0.92, 0.85, 1.7)
      )
    )
  );
  const adaptiveTargetDiffChars = Math.max(40000, Math.round(baseTarget * multiplier));
  const expansionScale = deadlinePressure.ratio > 0.9
    ? FOCUSED_REVIEW_EXPANSION_TARGET_MULTIPLIER
    : deadlinePressure.ratio > 0.7
      ? Math.max(1.04, FOCUSED_REVIEW_EXPANSION_TARGET_MULTIPLIER - 0.08)
      : 1.03;
  const expansionTargetDiffChars = Math.max(
    adaptiveTargetDiffChars,
    Math.round(adaptiveTargetDiffChars * expansionScale)
  );

  const triggerFileCount = Math.max(
    FOCUSED_REVIEW_ADAPTIVE_MIN_TRIGGER_FILE_COUNT,
    Math.round(FOCUSED_REVIEW_TRIGGER_FILE_COUNT * providerProfile.focusedTriggerFileCountBias)
  );
  const triggerDiffChars = Math.max(
    FOCUSED_REVIEW_ADAPTIVE_MIN_TRIGGER_DIFF_CHARS,
    Math.round(FOCUSED_REVIEW_TRIGGER_DIFF_CHARS * providerProfile.focusedTriggerDiffBias)
  );

  return {
    triggerFileCount,
    triggerDiffChars,
    minDeepFiles: adaptiveMin,
    maxDeepFiles: adaptiveMax,
    targetDiffChars: adaptiveTargetDiffChars,
    expansionTargetDiffChars,
    planner: {
      totalFiles,
      estimatedTotalChars,
      highRiskCount,
      highRiskRatio,
      budgetClass,
      multiplier,
      deadlineRemainingMs: deadlinePressure.remainingMs,
      deadlineRatio: deadlinePressure.ratio,
      providerCoverageMultiplier: providerProfile.coverageMultiplier,
    },
  };
}

// ── File Selection ───────────────────────────────────────────────────────────

function selectFilesForFocusedReview(files, {
  triggerFileCount = FOCUSED_REVIEW_TRIGGER_FILE_COUNT,
  maxDeepFiles = FOCUSED_REVIEW_MAX_DEEP_FILES,
  minDeepFiles = FOCUSED_REVIEW_MIN_DEEP_FILES,
  triggerDiffChars = FOCUSED_REVIEW_TRIGGER_DIFF_CHARS,
  targetDiffChars = FOCUSED_REVIEW_TARGET_DIFF_CHARS,
  expansionTargetDiffChars = null,
  planner = null,
} = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      mode: 'full',
      reviewFiles: [],
      omittedFiles: [],
      totalFiles: 0,
      planner: planner || null,
    };
  }

  const estimatedTotalChars = files.reduce((acc, file) => acc + estimateFileReviewSize(file), 0);
  const shouldFocusByCount = files.length >= triggerFileCount;
  const shouldFocusBySize = estimatedTotalChars >= triggerDiffChars;

  if (!shouldFocusByCount && !shouldFocusBySize) {
    return {
      mode: 'full',
      reviewFiles: files,
      omittedFiles: [],
      totalFiles: files.length,
      planner: planner || null,
    };
  }

  const prioritized = prioritizeNameStatusEntries(
    files.map((file) => ({
      path: file.path,
      oldPath: file.oldPath || null,
      status: file.status || 'M',
      profileClass: file.profileClass || null,
      estimatedSize: estimateFileReviewSize(file),
    }))
  );
  const rankedPaths = prioritized.map((entry) => normalizePathForMatch(entry.path));
  const selectedPathSet = new Set();
  const effectiveMinDeepFiles = Math.max(1, Number(minDeepFiles) || FOCUSED_REVIEW_MIN_DEEP_FILES);
  const effectiveMaxDeepFiles = Math.max(
    effectiveMinDeepFiles,
    Math.max(1, Number(maxDeepFiles) || FOCUSED_REVIEW_MAX_DEEP_FILES)
  );
  const effectiveTargetChars = Math.max(40000, Number(targetDiffChars) || FOCUSED_REVIEW_TARGET_DIFF_CHARS);
  const effectiveExpansionTargetChars = Math.max(
    effectiveTargetChars,
    Number(expansionTargetDiffChars) || 0
  );
  let selectedChars = 0;

  for (const entry of prioritized) {
    if (selectedPathSet.size >= effectiveMaxDeepFiles) break;

    const entryPath = normalizePathForMatch(entry.path);
    const estimatedSize = Number(entry.estimatedSize) || 0;
    const wouldExceedBudget = selectedChars + estimatedSize > effectiveTargetChars;
    const canBypassBudget = selectedPathSet.size < effectiveMinDeepFiles;
    if (wouldExceedBudget && !canBypassBudget) {
      continue;
    }

    selectedPathSet.add(entryPath);
    selectedChars += estimatedSize;
  }

  // If budget remains, expand coverage with the next-best omitted files instead of
  // stopping at the first focused subset.
  if (selectedPathSet.size < effectiveMaxDeepFiles && effectiveExpansionTargetChars > effectiveTargetChars) {
    for (const entry of prioritized) {
      if (selectedPathSet.size >= effectiveMaxDeepFiles) break;
      const entryPath = normalizePathForMatch(entry.path);
      if (!entryPath || selectedPathSet.has(entryPath)) continue;
      const estimatedSize = Number(entry.estimatedSize) || 0;
      if (selectedChars + estimatedSize > effectiveExpansionTargetChars) continue;
      selectedPathSet.add(entryPath);
      selectedChars += estimatedSize;
    }
  }

  if (selectedPathSet.size === 0 && rankedPaths.length > 0) {
    selectedPathSet.add(rankedPaths[0]);
  }

  const rankedReviewFiles = rankedPaths
    .map((path) => files.find((file) => normalizePathForMatch(file.path) === path))
    .filter(Boolean);

  const reviewFiles = rankedReviewFiles.filter((file) => selectedPathSet.has(normalizePathForMatch(file.path)));
  const omittedFiles = files.filter((file) => !selectedPathSet.has(normalizePathForMatch(file.path)));

  if (omittedFiles.length === 0) {
    return {
      mode: 'full',
      reviewFiles: files,
      omittedFiles: [],
      totalFiles: files.length,
      planner: planner || null,
    };
  }

  return {
    mode: 'focused',
    reviewFiles,
    omittedFiles,
    totalFiles: files.length,
    planner: planner || null,
  };
}

// ── Omission & Summary ───────────────────────────────────────────────────────

function buildOmissionReasonMap({
  focusedOmittedFiles = [],
  triageOmittedPaths = [],
  failedPaths = [],
} = {}) {
  const reasonMap = {};

  for (const file of Array.isArray(focusedOmittedFiles) ? focusedOmittedFiles : []) {
    const path = normalizePathForMatch(file?.path || '');
    if (!path) continue;
    reasonMap[path] = 'Focused risk-priority budget for this run.';
  }
  for (const filePath of Array.isArray(triageOmittedPaths) ? triageOmittedPaths : []) {
    const path = normalizePathForMatch(filePath);
    if (!path || reasonMap[path]) continue;
    reasonMap[path] = 'Skipped in per-file triage as low-signal/trivial.';
  }
  for (const filePath of Array.isArray(failedPaths) ? failedPaths : []) {
    const path = normalizePathForMatch(filePath);
    if (!path) continue;
    reasonMap[path] = 'Per-file analysis failed in this run (timeout/provider/network).';
  }

  return reasonMap;
}

function synthesizeLargeReviewSummary({
  chunkCount,
  summaryText,
  focusedFiles,
  totalFiles,
  omittedFiles,
  recommendations,
}) {
  const parts = [];
  const hasFocusedMode = omittedFiles > 0 && focusedFiles > 0 && totalFiles > focusedFiles;

  if (chunkCount > 1) {
    parts.push(`Analyzed in ${chunkCount} chunks.`);
  }
  if (hasFocusedMode) {
    parts.push(`Focused deep analysis on ${focusedFiles}/${totalFiles} risk-prioritized files.`);
  }

  const topIssues = recommendations
    .filter((rec) => rec.type === 'issue' && (rec.severity === 'critical' || rec.severity === 'high'))
    .slice(0, 2)
    .map((rec) => rec.title?.trim())
    .filter(Boolean);
  if (topIssues.length > 0) {
    parts.push(`Top risks: ${topIssues.join('; ')}.`);
  }

  const summary = String(summaryText || '').trim();
  if (summary) parts.push(summary);

  const combined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return combined.length > 420 ? `${combined.slice(0, 417)}...` : combined;
}

// ── Chunking ─────────────────────────────────────────────────────────────────

function chunkFilesForReview(files, targetChars = REVIEW_CHUNK_CHAR_LIMIT, maxChunks = REVIEW_MAX_CHUNKS) {
  if (!files.length) return [];

  const chunks = [];
  let currentChunk = [];
  let currentChars = 0;

  for (const file of files) {
    const approxChars = Math.max(256, estimateFileReviewSize(file));

    if (currentChunk.length > 0 && currentChars + approxChars > targetChars) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }

    currentChunk.push(file);
    currentChars += approxChars;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  if (chunks.length <= maxChunks) {
    return chunks;
  }

  // Keep chunk count bounded: merge overflow into the final chunk.
  const bounded = chunks.slice(0, maxChunks - 1);
  const overflow = chunks.slice(maxChunks - 1).flat();
  bounded.push(overflow);
  return bounded;
}

// ── Exports ──────────────────────────────────────────────────────────────────

export {
  resolveDeadlinePressure,
  resolveReviewPromptVersionForCache,
  buildReviewFileCacheDescriptor,
  getProviderCandidatesInPreferredOrder,
  isValidCachedPerFileReview,
  estimateModifiedPatchChars,
  estimateFileReviewSize,
  buildDiffStatMap,
  estimateReviewSizeHintFromDiffStat,
  resolveProfileClassification,
  computeShapedReviewSize,
  shapeReviewScopeForProfile,
  scoreNameStatusEntry,
  prioritizeNameStatusEntries,
  summarizeOmittedFilesForPrompt,
  deriveFocusedReviewBudgetConfig,
  selectFilesForFocusedReview,
  buildOmissionReasonMap,
  synthesizeLargeReviewSummary,
  chunkFilesForReview,
};
