/**
 * Review Quality Harness
 *
 * Tests the AI review engine against synthetic diffs with known issues.
 * Each fixture has:
 *   - files: synthetic before/after file contents
 *   - metadata: changeset title, risk flags, etc.
 *   - expectations: minimum requirements the review must meet
 *
 * Running the harness sends each fixture through the live AI provider
 * and scores the response against golden expectations. This catches
 * prompt regressions without brittle exact-match comparisons.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import reviewService from './reviewService.js';
import providerService from './providerService.js';
import { extractPrecisionMetricsFromStats } from './reviewPrecisionMetrics.js';
import {
  callProviderForReviewWithFailover,
  buildCliAgenticDiscoveryPrompt,
  buildBehavioralHotspotDistillation,
} from './review/reviewProviderExecution.js';
import { mergeDeterministicFindingsIntoReview } from './review/linter/linterMerge.js';
import {
  buildHighRiskVerifierPrompt,
  parseHighRiskVerifierDecision,
  runCandidateFindingPromotionPass,
} from './review/reviewVerifier.js';
import { runUnitySemanticVerifier } from './review/unitySemanticVerifier.js';
import { getReviewProfileById } from './review/reviewProjectProfileService.js';
import { signalMatchesHistoricalBugClass } from './review/reviewHistoricalSignals.js';

// ── Test fixtures ────────────────────────────────────────────────────

/**
 * @typedef {Object} Expectation
 * @property {string} id - Unique fixture identifier
 * @property {string} label - Human-readable description
 * @property {Object[]} files - Synthetic file changes (path, before, after)
 * @property {Object} metadata - Title, risk flags, etc.
 * @property {'changeset'|'pr_review'|'branch_review'|'workspace_review'} [surface] - Primary review surface represented by the fixture
 * @property {string} [fixtureSet] - Fixture collection identifier used for focused benchmark runs
 * @property {Object} golden - Minimum requirements for a passing review
 * @property {string[]} golden.mustMentionKeywords - Keywords the review must reference
 * @property {number} [golden.minIssues] - Minimum issue-type recommendations
 * @property {number} [golden.maxIssues] - Maximum issue-type recommendations (false-positive control)
 * @property {number} [golden.minHighSeverity] - Minimum high/critical severity recs
 * @property {string} [golden.minRiskLevel] - Minimum overall risk level
 * @property {string[]} [golden.mustFlagFiles] - Files that must appear in recommendations
 * @property {number} [golden.maxRecommendations] - Maximum total recommendations allowed
 * @property {number} [golden.maxNonIssueRecommendations] - Maximum non-issue recommendations
 * @property {number} [golden.minIssueWithFileRatio] - Minimum ratio of issue recs with file references
 * @property {number} [golden.minIssueWithLineRatio] - Minimum ratio of issue recs with line references
 * @property {number} [golden.minActionableRatio] - Minimum ratio of issue/suggestion recs with actionable fix direction
 * @property {number} [golden.minCommentEligibleIssues] - Minimum issue findings eligible for GitHub comments
 * @property {number} [golden.maxWithheldFindings] - Maximum withheld GitHub comment findings
 * @property {number} [golden.minDeepCoverageRate] - Minimum deep coverage ratio from persisted review stats
 * @property {boolean} [golden.requireVerificationSummary] - Require persisted verification summary/check lines
 * @property {boolean} [golden.requireImpactForHighSeverity] - If true, high/critical findings must include impact language
 * @property {number} [golden.maxSummarySentences] - Maximum summary sentence count
 * @property {number} [golden.minCandidateFindings] - Minimum total candidate findings retained after review
 * @property {number} [golden.minPromotedCandidateFindings] - Minimum candidate findings promoted into recommendations
 * @property {number} [golden.maxRemainingCandidateFindings] - Maximum candidate findings left unpromoted
 * @property {string[]} [golden.mustMentionKeywordsInCandidates] - Keywords that must appear in candidate finding titles or descriptions
 * @property {string[]} [golden.mustMatchBugClasses] - Semantic bug classes that may satisfy wording-sensitive expectations
 * @property {string[]} [golden.mustMatchBugClassesInCandidates] - Semantic bug classes that may satisfy candidate-finding expectations
 * @property {string[]} [golden.mustMatchAnyBugClassesInCandidates] - Any one of these semantic bug classes may satisfy candidate-finding expectations
 * @property {string[]} [golden.mustMatchAnyBugClassesInFindings] - Any one of these semantic bug classes may satisfy the review via recommendations or candidate findings
 */

const RISK_ORDER = ['low', 'medium', 'high', 'critical'];
const IMPACT_RE = /\b(security|injection|xss|data\s+loss|outage|downtime|crash|corrupt|integrity|availability|privilege|leak|broken|failure)\b/i;
const ACTIONABLE_RE = /\b(use|replace|switch|validate|sanitize|escape|parameterize|add|remove|guard|handle|wrap|return|throw|check|limit|retry|fallback|migrate)\b/i;
const TIMEOUT_OR_DEADLINE_RE = /\b(timeout|timed out|deadline exceeded)\b/i;
const DEFAULT_ROLLOUT_GATE_THRESHOLDS = Object.freeze({
  minCompletedFixtures: 5,
  minPassRateDelta: 0,
  minAvgScoreDelta: 0,
  maxDurationP95Ms: 210000,
  maxTimeoutOrDeadlineErrorRate: 0.1,
  maxPartialRate: 0.2,
  minDeepCoverageRate: 0.7,
  maxErrorRateRegression: 0.02,
  minHighRiskIssueCoverageRate: 0.75,
  minFirstSignalDataRate: 0.25,
  maxFirstSignalP95Ms: 90000,
  minChunkCadencePerMinute: 0.5,
  minMediumVerifierCoverageRate: 0,
  maxUnsupportedIssueRate: 0.45,
  maxLowEvidenceIssueRate: 0.55,
  maxDismissedIssueRate: 0.6,
  maxUncorroboratedHighRiskRate: 0.5,
  maxOutcomeSuppressionRate: 0.75,
});
const DEFAULT_ADAPTIVE_THRESHOLDS = Object.freeze({
  fastPathMaxFiles: 12,
  fastPathMaxDiffChars: 20000,
  preferQualityOnHighRisk: true,
});
const DEFAULT_TUNING_TARGETS = Object.freeze({
  minFastPathCoverageRate: 0.35,
  maxFastPathCoverageRate: 0.75,
  maxDeepScopePressureRate: 0.65,
  minDeepCoverageRate: 0.72,
  maxDurationP95Ms: 180000,
  maxRecommendationBudgetPressureRate: 0.45,
  minHighRiskIssueCoverageRate: 0.75,
  minFirstSignalDataRate: 0.25,
  maxFirstSignalP95Ms: 90000,
  minChunkCadencePerMinute: 0.5,
});

const DEFAULT_STRATEGY_MATRIX = Object.freeze(['latency_first', 'smart', 'max_quality']);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FIXTURE_ROOT = path.resolve(MODULE_DIR, '../../config/review-harness-benchmarks');

function normalizeFixtureSurface(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'pr_review' || normalized === 'branch_review' || normalized === 'workspace_review') {
    return normalized;
  }
  return 'changeset';
}

function normalizeFixtureSet(value, surface = 'changeset') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized) return normalized;
  return surface === 'pr_review' ? 'pr_review' : 'core';
}

function normalizeBenchmarkDimensions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [String(key || '').trim(), String(entryValue || '').trim()])
      .filter(([key, entryValue]) => key && entryValue)
  );
}

function isCandidateFocusedGolden(golden = null) {
  if (!golden || typeof golden !== 'object' || Array.isArray(golden)) return false;
  return (
    golden.minCandidateFindings != null
    || golden.minPromotedCandidateFindings != null
    || golden.maxRemainingCandidateFindings != null
    || (Array.isArray(golden.mustMentionKeywordsInCandidates) && golden.mustMentionKeywordsInCandidates.length > 0)
    || (Array.isArray(golden.mustMatchBugClassesInCandidates) && golden.mustMatchBugClassesInCandidates.length > 0)
    || (Array.isArray(golden.mustMatchAnyBugClassesInCandidates) && golden.mustMatchAnyBugClassesInCandidates.length > 0)
    || (Array.isArray(golden.mustMatchAnyBugClassesInFindings) && golden.mustMatchAnyBugClassesInFindings.length > 0)
  );
}

function deriveFixtureEvaluationFocus(fixture = {}) {
  return isCandidateFocusedGolden(fixture?.golden)
    ? 'candidate_generation'
    : 'direct_findings';
}

function inferUnityRootFromFixtureFiles(files = []) {
  const roots = [];

  for (const entry of Array.isArray(files) ? files : []) {
    const normalizedPath = String(entry?.path || '').trim().replace(/\\/g, '/');
    if (!normalizedPath) continue;

    if (normalizedPath === 'Assets' || normalizedPath.startsWith('Assets/')) {
      roots.push('');
      continue;
    }

    for (const marker of ['/Assets/', '/ProjectSettings/', '/Packages/']) {
      const markerIndex = normalizedPath.indexOf(marker);
      if (markerIndex >= 0) {
        roots.push(normalizedPath.slice(0, markerIndex).replace(/\/+$/, ''));
      }
    }
  }

  if (roots.length === 0) return null;
  return roots.sort((left, right) => left.length - right.length)[0] ?? null;
}

function resolveHarnessReviewProfile(rawReviewProfile = null, files = []) {
  if (!rawReviewProfile || typeof rawReviewProfile !== 'object' || Array.isArray(rawReviewProfile)) {
    return null;
  }

  const baseProfile = getReviewProfileById(rawReviewProfile.id || rawReviewProfile.presetId || 'generic');
  const projectContext = {
    ...(baseProfile?.projectContext && typeof baseProfile.projectContext === 'object' ? baseProfile.projectContext : {}),
    ...(rawReviewProfile?.projectContext && typeof rawReviewProfile.projectContext === 'object' ? rawReviewProfile.projectContext : {}),
  };

  const mergedProfile = {
    ...baseProfile,
    ...rawReviewProfile,
    projectContext,
  };

  if (mergedProfile.stackFamily === 'unity' && !String(projectContext.unityRoot || '').trim()) {
    const inferredUnityRoot = inferUnityRootFromFixtureFiles(files);
    if (inferredUnityRoot !== null) {
      mergedProfile.projectContext = {
        ...projectContext,
        unityRoot: inferredUnityRoot,
      };
    }
  }

  return mergedProfile;
}

function enrichFixtureDefinition(fixture = {}) {
  const surface = normalizeFixtureSurface(fixture.surface);
  const benchmarkDimensions = normalizeBenchmarkDimensions(fixture.benchmarkDimensions);
  const evaluationFocus = deriveFixtureEvaluationFocus(fixture);
  return {
    ...fixture,
    surface,
    fixtureSet: normalizeFixtureSet(fixture.fixtureSet, surface),
    benchmarkDimensions: {
      ...benchmarkDimensions,
      evaluationFocus,
    },
  };
}

function safeRecommendations(review) {
  return Array.isArray(review?.recommendations) ? review.recommendations : [];
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return 1;
  return numerator / denominator;
}

function toClampedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeAdaptiveThresholds(raw = null) {
  const parsed = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    fastPathMaxFiles: toClampedInteger(
      parsed.fastPathMaxFiles,
      DEFAULT_ADAPTIVE_THRESHOLDS.fastPathMaxFiles,
      1,
      200
    ),
    fastPathMaxDiffChars: toClampedInteger(
      parsed.fastPathMaxDiffChars,
      DEFAULT_ADAPTIVE_THRESHOLDS.fastPathMaxDiffChars,
      2000,
      1000000
    ),
    preferQualityOnHighRisk:
      typeof parsed.preferQualityOnHighRisk === 'boolean'
        ? parsed.preferQualityOnHighRisk
        : DEFAULT_ADAPTIVE_THRESHOLDS.preferQualityOnHighRisk,
  };
}

function normalizeTuningTargets(raw = null) {
  const parsed = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    minFastPathCoverageRate: Math.min(1, Math.max(0, Number(parsed.minFastPathCoverageRate ?? DEFAULT_TUNING_TARGETS.minFastPathCoverageRate))),
    maxFastPathCoverageRate: Math.min(1, Math.max(0, Number(parsed.maxFastPathCoverageRate ?? DEFAULT_TUNING_TARGETS.maxFastPathCoverageRate))),
    maxDeepScopePressureRate: Math.min(1, Math.max(0, Number(parsed.maxDeepScopePressureRate ?? DEFAULT_TUNING_TARGETS.maxDeepScopePressureRate))),
    minDeepCoverageRate: Math.min(1, Math.max(0, Number(parsed.minDeepCoverageRate ?? DEFAULT_TUNING_TARGETS.minDeepCoverageRate))),
    maxDurationP95Ms: Math.max(1000, Number(parsed.maxDurationP95Ms ?? DEFAULT_TUNING_TARGETS.maxDurationP95Ms)),
    maxRecommendationBudgetPressureRate: Math.min(1, Math.max(0, Number(
      parsed.maxRecommendationBudgetPressureRate ?? DEFAULT_TUNING_TARGETS.maxRecommendationBudgetPressureRate
    ))),
    minHighRiskIssueCoverageRate: Math.min(1, Math.max(0, Number(
      parsed.minHighRiskIssueCoverageRate ?? DEFAULT_TUNING_TARGETS.minHighRiskIssueCoverageRate
    ))),
    minFirstSignalDataRate: Math.min(1, Math.max(0, Number(parsed.minFirstSignalDataRate ?? DEFAULT_TUNING_TARGETS.minFirstSignalDataRate))),
    maxFirstSignalP95Ms: Math.max(1000, Number(parsed.maxFirstSignalP95Ms ?? DEFAULT_TUNING_TARGETS.maxFirstSignalP95Ms)),
    minChunkCadencePerMinute: Math.max(0, Number(parsed.minChunkCadencePerMinute ?? DEFAULT_TUNING_TARGETS.minChunkCadencePerMinute)),
  };
}

function countSummarySentences(summary) {
  if (typeof summary !== 'string') return 0;
  const trimmed = summary.trim();
  if (!trimmed) return 0;
  return trimmed
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .length;
}

function hasActionableDirection(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (typeof rec.suggestedFix === 'string' && rec.suggestedFix.trim()) return true;
  const text = `${rec.title || ''} ${rec.description || ''}`;
  return ACTIONABLE_RE.test(text);
}

function estimateLineChanges(files) {
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const file of files || []) {
    const before = typeof file.before === 'string' ? file.before : null;
    const after = typeof file.after === 'string' ? file.after : null;

    if (before == null && after != null) {
      totalAdditions += after.split('\n').length;
      continue;
    }
    if (after == null && before != null) {
      totalDeletions += before.split('\n').length;
      continue;
    }
    if (before != null && after != null) {
      const beforeLines = before.split('\n').length;
      const afterLines = after.split('\n').length;
      totalAdditions += Math.max(0, afterLines - beforeLines);
      totalDeletions += Math.max(0, beforeLines - afterLines);
    }
  }

  return { totalAdditions, totalDeletions };
}

function estimateRecommendationBudget(fileCount) {
  const normalized = Number.isFinite(Number(fileCount)) ? Number(fileCount) : 0;
  if (normalized <= 10) return 2;
  if (normalized <= 40) return 4;
  return 6;
}

function classifyFixtureSize(context) {
  const fileCount = Number(context?.fileCount) || 0;
  const diffChars = Number(context?.diffChars) || 0;
  if (fileCount <= 10 && diffChars <= 20000) return 'small';
  if (fileCount <= 40 && diffChars <= 150000) return 'medium';
  return 'large';
}

function classifyFixtureRisk(context) {
  return context?.highRiskHint ? 'high_risk' : 'low_risk';
}

function buildScenarioDescriptor(context) {
  const sizeClass = classifyFixtureSize(context);
  const riskClass = classifyFixtureRisk(context);
  return {
    sizeClass,
    riskClass,
    key: `${sizeClass}:${riskClass}`,
  };
}

function inferFixtureHighRiskHint(fixture) {
  const minRisk = fixture?.golden?.minRiskLevel;
  if (minRisk === 'high' || minRisk === 'critical') return true;
  const metadata = fixture?.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const riskFlags = metadata.riskFlags;
  if (!riskFlags || typeof riskFlags !== 'object') return false;
  return Object.values(riskFlags).some(Boolean);
}

function normalizeStrategyValue(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return normalized;
}

function collectSnapshotFixtureFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];

  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'fixtures') {
          const fixtureFiles = fs.readdirSync(fullPath, { withFileTypes: true })
            .filter((child) => child.isFile() && child.name.endsWith('.json'))
            .map((child) => path.join(fullPath, child.name));
          results.push(...fixtureFiles);
          continue;
        }
        stack.push(fullPath);
      }
    }
  }

  return results.sort((left, right) => left.localeCompare(right));
}

function loadSnapshotFixtures(rootDir = SNAPSHOT_FIXTURE_ROOT) {
  const fixtureFiles = collectSnapshotFixtureFiles(rootDir);
  return fixtureFiles.map((fixturePath) => {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    } catch (error) {
      throw new Error(`Failed to parse review harness fixture ${fixturePath}: ${error.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Review harness fixture ${fixturePath} must contain a JSON object.`);
    }
    if (!String(parsed.id || '').trim()) {
      throw new Error(`Review harness fixture ${fixturePath} is missing a valid id.`);
    }
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
      throw new Error(`Review harness fixture ${fixturePath} must define a non-empty files array.`);
    }

    return enrichFixtureDefinition(parsed);
  });
}

const STATIC_FIXTURES = [
  // ── 1. SQL Injection ──────────────────────────────────────────────
  {
    id: 'sql-injection',
    label: 'SQL injection via string interpolation',
    files: [
      {
        path: 'src/routes/users.js',
        before: `const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/users', async (req, res) => {
  const users = await db.query('SELECT * FROM users');
  res.json(users.rows);
});

module.exports = router;`,
        after: `const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/users', async (req, res) => {
  const users = await db.query('SELECT * FROM users');
  res.json(users.rows);
});

router.get('/users/search', async (req, res) => {
  const { name } = req.query;
  const result = await db.query(\`SELECT * FROM users WHERE name = '\${name}'\`);
  res.json(result.rows);
});

module.exports = router;`,
      },
    ],
    metadata: { title: 'Add user search endpoint' },
    golden: {
      mustMentionKeywords: ['sql', 'injection'],
      minIssues: 1,
      minHighSeverity: 1,
      minRiskLevel: 'high',
      mustFlagFiles: ['src/routes/users.js'],
      maxRecommendations: 6,
      minIssueWithFileRatio: 1,
      minIssueWithLineRatio: 0.5,
      minActionableRatio: 0.6,
      requireImpactForHighSeverity: true,
      maxSummarySentences: 4,
    },
  },

  // ── 2. XSS via innerHTML ──────────────────────────────────────────
  {
    id: 'xss-innerhtml',
    label: 'XSS vulnerability via dangerouslySetInnerHTML',
    files: [
      {
        path: 'src/components/Comment.tsx',
        before: null,
        after: `import React from 'react';

interface CommentProps {
  author: string;
  body: string;
}

export function Comment({ author, body }: CommentProps) {
  return (
    <div className="comment">
      <h3>{author}</h3>
      <div dangerouslySetInnerHTML={{ __html: body }} />
    </div>
  );
}`,
      },
    ],
    metadata: { title: 'Add comment component' },
    golden: {
      mustMentionKeywords: ['xss', 'dangerously'],
      minIssues: 1,
      minHighSeverity: 1,
      minRiskLevel: 'high',
      mustFlagFiles: ['src/components/Comment.tsx'],
      maxRecommendations: 6,
      minIssueWithFileRatio: 1,
      minIssueWithLineRatio: 0.5,
      minActionableRatio: 0.6,
      requireImpactForHighSeverity: true,
      maxSummarySentences: 4,
    },
  },

  // ── 3. Hardcoded secret ───────────────────────────────────────────
  {
    id: 'hardcoded-secret',
    label: 'Hardcoded API key in source',
    files: [
      {
        path: 'src/config.js',
        before: `module.exports = {
  port: process.env.PORT || 3000,
  dbUrl: process.env.DATABASE_URL,
};`,
        after: `module.exports = {
  port: process.env.PORT || 3000,
  dbUrl: process.env.DATABASE_URL,
  stripeKey: 'sk_live_51H7bRmKj3e8N9x2YfGhTq4wZ',
  jwtSecret: 'super-secret-key-12345',
};`,
      },
    ],
    metadata: { title: 'Add payment and auth config' },
    golden: {
      mustMentionKeywords: ['secret', 'key'],
      minIssues: 1,
      minHighSeverity: 1,
      minRiskLevel: 'high',
      mustFlagFiles: ['src/config.js'],
      maxRecommendations: 6,
      minIssueWithFileRatio: 1,
      minIssueWithLineRatio: 0.5,
      minActionableRatio: 0.6,
      requireImpactForHighSeverity: true,
      maxSummarySentences: 4,
    },
  },

  // ── 4. Missing error handling ─────────────────────────────────────
  {
    id: 'missing-error-handling',
    label: 'Async operations without try-catch',
    files: [
      {
        path: 'src/services/fileService.js',
        before: null,
        after: `import fs from 'fs/promises';

export async function readUserData(userId) {
  const data = await fs.readFile(\`/data/users/\${userId}.json\`, 'utf8');
  const parsed = JSON.parse(data);
  const profile = await fetch(\`https://api.example.com/profiles/\${parsed.profileId}\`);
  const profileData = await profile.json();
  await fs.writeFile(\`/data/cache/\${userId}.json\`, JSON.stringify(profileData));
  return profileData;
}`,
      },
    ],
    metadata: { title: 'Add file service for user data' },
    golden: {
      mustMentionKeywords: ['error'],
      minIssues: 1,
      minHighSeverity: 0,
      minRiskLevel: 'medium',
      mustFlagFiles: ['src/services/fileService.js'],
      maxRecommendations: 5,
      minIssueWithFileRatio: 1,
      minIssueWithLineRatio: 0.5,
      minActionableRatio: 0.5,
      maxSummarySentences: 4,
    },
  },

  // ── 5. Clean code (should pass) ───────────────────────────────────
  {
    id: 'clean-code',
    label: 'Well-written utility function (should stay concise)',
    files: [
      {
        path: 'src/utils/format.ts',
        before: null,
        after: `/**
 * Format a byte count into a human-readable string.
 * @param bytes - Number of bytes
 * @param decimals - Decimal places (default 2)
 * @returns Formatted string like "1.5 MB"
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';
  if (bytes < 0) throw new RangeError('bytes must be non-negative');

  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);

  return \`\${parseFloat((bytes / Math.pow(k, idx)).toFixed(dm))} \${sizes[idx]}\`;
}`,
      },
    ],
    metadata: { title: 'Add byte formatting utility' },
    golden: {
      mustMentionKeywords: [],
      minIssues: 0,
      maxIssues: 0,
      minHighSeverity: 0,
      minRiskLevel: 'low',
      mustFlagFiles: [],
      maxRecommendations: 2,
      maxNonIssueRecommendations: 2,
      maxSummarySentences: 4,
    },
  },

  // ── 6. Lockfile/config churn (should avoid overreaction) ──────────
  {
    id: 'lockfile-config-churn',
    label: 'Lockfile and docs update only',
    files: [
      {
        path: 'package-lock.json',
        before: `{"name":"app","lockfileVersion":3,"packages":{"":{"dependencies":{"react":"18.2.0"}}}}`,
        after: `{"name":"app","lockfileVersion":3,"packages":{"":{"dependencies":{"react":"18.3.1"}}}}`,
      },
      {
        path: 'README.md',
        before: '# App\n\nInstall with npm install',
        after: '# App\n\nInstall with npm ci',
      },
    ],
    metadata: { title: 'Update dependency lockfile and docs' },
    golden: {
      minIssues: 0,
      maxIssues: 0,
      minRiskLevel: 'low',
      maxRecommendations: 2,
      maxNonIssueRecommendations: 2,
      maxSummarySentences: 4,
    },
  },

  // ── 7. Tiny safe refactor (should be concise) ─────────────────────
  {
    id: 'tiny-safe-refactor',
    label: 'Small variable rename/refactor with no behavior change',
    files: [
      {
        path: 'src/utils/math.ts',
        before: `export function clamp(v: number, min: number, max: number) {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}`,
        after: `export function clamp(value: number, min: number, max: number) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}`,
      },
    ],
    metadata: { title: 'Refactor clamp parameter naming' },
    golden: {
      minIssues: 0,
      maxIssues: 0,
      minRiskLevel: 'low',
      maxRecommendations: 2,
      maxNonIssueRecommendations: 2,
      maxSummarySentences: 3,
    },
  },

  // ── 8. Multi-file auth regression (should escalate) ───────────────
  {
    id: 'auth-regression-multi-file',
    label: 'Authorization removed across middleware and route',
    files: [
      {
        path: 'src/middleware/auth.js',
        before: `export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}`,
        after: `export function requireAuth(_req, _res, next) {
  next();
}`,
      },
      {
        path: 'src/routes/admin.js',
        before: `import { requireAuth } from '../middleware/auth';
router.delete('/admin/users/:id', requireAuth, async (req, res) => {
  await deleteUser(req.params.id);
  res.status(204).end();
});`,
        after: `router.delete('/admin/users/:id', async (req, res) => {
  await deleteUser(req.params.id);
  res.status(204).end();
});`,
      },
    ],
    metadata: { title: 'Simplify admin route flow' },
    golden: {
      mustMentionKeywords: ['auth', 'unauthorized'],
      minIssues: 1,
      minHighSeverity: 1,
      minRiskLevel: 'high',
      mustFlagFiles: ['src/middleware/auth.js', 'src/routes/admin.js'],
      maxRecommendations: 7,
      minIssueWithFileRatio: 1,
      minIssueWithLineRatio: 0.5,
      minActionableRatio: 0.6,
      requireImpactForHighSeverity: true,
      maxSummarySentences: 4,
    },
  },

  // ── 9. AI-generated anti-pattern (should catch concrete issue) ─────
  {
    id: 'ai-antipattern-eval',
    label: 'Unsafe eval introduced in request handling',
    files: [
      {
        path: 'src/routes/template.js',
        before: `router.post('/render', (req, res) => {
  const { template } = req.body;
  res.send(renderTemplate(template));
});`,
        after: `router.post('/render', (req, res) => {
  const { template, data } = req.body;
  const fn = eval(\`(ctx) => \${template}\`);
  res.send(fn(data));
});`,
      },
    ],
    metadata: { title: 'AI-generated template rendering helper' },
    golden: {
      mustMentionKeywords: ['eval'],
      minIssues: 1,
      minHighSeverity: 1,
      minRiskLevel: 'high',
      mustFlagFiles: ['src/routes/template.js'],
      maxRecommendations: 5,
      minIssueWithFileRatio: 1,
      minIssueWithLineRatio: 0.5,
      minActionableRatio: 0.6,
      requireImpactForHighSeverity: true,
      maxSummarySentences: 4,
    },
  },

  // ── 10. PR / Unity lifecycle regression ───────────────────────────
  {
    id: 'pr-unity-lifecycle-regression',
    label: 'PR: Unity event subscription leak after lifecycle change',
    surface: 'pr_review',
    fixtureSet: 'pr_review',
    files: [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/UI/LoadoutPanelPresenter.cs',
        before: `using UnityEngine;

public class LoadoutPanelPresenter : MonoBehaviour {
  [SerializeField] private InventoryStore inventoryStore;

  private void OnEnable() {
    inventoryStore.Changed += Refresh;
    Refresh();
  }

  private void OnDisable() {
    inventoryStore.Changed -= Refresh;
  }

  private void Refresh() {
  }
}`,
        after: `using UnityEngine;

public class LoadoutPanelPresenter : MonoBehaviour {
  [SerializeField] private InventoryStore inventoryStore;

  private void OnEnable() {
    inventoryStore.Changed += Refresh;
    Refresh();
  }

  private void OnDisable() {
    Refresh();
  }

  private void Refresh() {
  }
}`,
      },
    ],
    metadata: {
      title: 'PR #481: Refresh loadout panel when inventory changes',
      commitMessages: [
        'PR description: Keep the loadout panel in sync while the inventory screen is open.',
        'refactor: simplify loadout panel lifecycle hooks',
      ],
      requestedReviewers: ['unity-client'],
      assignees: ['client-owner'],
      reviewThreads: [
        'Project_BLACK/BLACK_Unity/Assets/Scripts/UI/LoadoutPanelPresenter.cs:10 unresolved thread from gameplay-eng - This still needs symmetric unsubscribe behavior when the panel closes.',
      ],
      reviewProfile: {
        id: 'unity_csharp',
        label: 'Unity / C#',
        source: 'detected',
      },
      shapedScope: {
        rawFileCount: 1,
        reviewUnitCount: 1,
        classCounts: {
          deep: 1,
          structural: 0,
          shallow: 0,
          collapsed: 0,
          skip: 0,
        },
      },
    },
    golden: {
      mustMentionKeywords: ['unsubscribe', 'duplicate'],
      minIssues: 1,
      minRiskLevel: 'medium',
      mustFlagFiles: ['Project_BLACK/BLACK_Unity/Assets/Scripts/UI/LoadoutPanelPresenter.cs'],
      maxRecommendations: 4,
      minIssueWithFileRatio: 1,
      minIssueWithLineRatio: 0.5,
      minActionableRatio: 0.5,
      maxSummarySentences: 4,
    },
  },

  // ── 11. PR / Unity prefab reference regression ───────────────────
  {
    id: 'pr-unity-prefab-reference-regression',
    label: 'PR: Unity serialized field rename without prefab migration',
    surface: 'pr_review',
    fixtureSet: 'pr_review',
    files: [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/UI/RewardPopupView.cs',
        before: `using TMPro;
using UnityEngine;

public class RewardPopupView : MonoBehaviour {
  [SerializeField] private TMP_Text rewardLabel;

  public void SetReward(string value) {
    rewardLabel.text = value;
  }
}`,
        after: `using TMPro;
using UnityEngine;

public class RewardPopupView : MonoBehaviour {
  [SerializeField] private TMP_Text amountLabel;

  public void SetReward(string value) {
    amountLabel.text = value;
  }
}`,
      },
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Prefabs/RewardPopup.prefab',
        before: `--- !u!114 &11400000
MonoBehaviour:
  m_Script: {fileID: 11500000, guid: reward-popup-view, type: 3}
  rewardLabel: {fileID: 220000, guid: popup-text, type: 3}
`,
        after: `--- !u!114 &11400000
MonoBehaviour:
  m_Enabled: 1
  m_Script: {fileID: 11500000, guid: reward-popup-view, type: 3}
  rewardLabel: {fileID: 220000, guid: popup-text, type: 3}
`,
      },
    ],
    metadata: {
      title: 'PR #482: Rename reward label field for clarity',
      commitMessages: [
        'PR description: Small cleanup before adding richer popup animations.',
        'refactor: rename rewardLabel to amountLabel',
      ],
      requestedReviewers: ['unity-ui'],
      reviewProfile: {
        id: 'unity_csharp',
        label: 'Unity / C#',
        source: 'detected',
      },
      shapedScope: {
        rawFileCount: 2,
        reviewUnitCount: 2,
        classCounts: {
          deep: 1,
          structural: 1,
          shallow: 0,
          collapsed: 0,
          skip: 0,
        },
      },
    },
    golden: {
      mustMentionKeywords: ['serialized', 'prefab'],
      minIssues: 1,
      minRiskLevel: 'medium',
      mustFlagFiles: [
        'Project_BLACK/BLACK_Unity/Assets/Scripts/UI/RewardPopupView.cs',
        'Project_BLACK/BLACK_Unity/Assets/Prefabs/RewardPopup.prefab',
      ],
      maxRecommendations: 5,
      minIssueWithFileRatio: 1,
      minIssueWithLineRatio: 0.5,
      minActionableRatio: 0.5,
      maxSummarySentences: 4,
    },
  },

  // ── 12. PR / Unity asmdef-package regression ─────────────────────
  {
    id: 'pr-unity-asmdef-package-regression',
    label: 'PR: Runtime assembly now depends on editor-only package',
    surface: 'pr_review',
    fixtureSet: 'pr_review',
    files: [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/Gameplay.Runtime.asmdef',
        before: `{
  "name": "Gameplay.Runtime",
  "references": [],
  "includePlatforms": [],
  "excludePlatforms": [],
  "allowUnsafeCode": false
}`,
        after: `{
  "name": "Gameplay.Runtime",
  "references": [
    "Unity.Addressables",
    "Unity.Localization.Editor"
  ],
  "includePlatforms": [],
  "excludePlatforms": [],
  "allowUnsafeCode": false
}`,
      },
      {
        path: 'Project_BLACK/BLACK_Unity/Packages/manifest.json',
        before: `{
  "dependencies": {
    "com.unity.addressables": "1.21.19"
  }
}`,
        after: `{
  "dependencies": {
    "com.unity.addressables": "1.21.19",
    "com.unity.localization": "1.5.4"
  }
}`,
      },
    ],
    metadata: {
      title: 'PR #483: Add localization support to gameplay runtime',
      commitMessages: [
        'PR description: Wire localization into gameplay prompts.',
        'feat: add localization package and assembly references',
      ],
      requestedReviewers: ['unity-platform'],
      reviewProfile: {
        id: 'unity_csharp',
        label: 'Unity / C#',
        source: 'detected',
      },
      shapedScope: {
        rawFileCount: 2,
        reviewUnitCount: 2,
        classCounts: {
          deep: 2,
          structural: 0,
          shallow: 0,
          collapsed: 0,
          skip: 0,
        },
      },
    },
    golden: {
      mustMentionKeywords: ['editor', 'runtime'],
      minIssues: 1,
      minRiskLevel: 'high',
      mustFlagFiles: ['Project_BLACK/BLACK_Unity/Assets/Scripts/Gameplay/Gameplay.Runtime.asmdef'],
      maxRecommendations: 5,
      minIssueWithFileRatio: 1,
      minIssueWithLineRatio: 0.5,
      minActionableRatio: 0.5,
      maxSummarySentences: 4,
    },
  },

  // ── 13. PR / Unity low-signal churn ──────────────────────────────
  {
    id: 'pr-unity-low-signal-asset-churn',
    label: 'PR: Unity low-signal art and meta churn should stay quiet',
    surface: 'pr_review',
    fixtureSet: 'pr_review',
    files: [
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Art/UI/RewardPopup.png.meta',
        before: `fileFormatVersion: 2
guid: reward-popup-png
TextureImporter:
  mipmaps:
    enableMipMap: 0
`,
        after: `fileFormatVersion: 2
guid: reward-popup-png
TextureImporter:
  mipmaps:
    enableMipMap: 1
`,
      },
      {
        path: 'Project_BLACK/BLACK_Unity/Assets/Art/UI/RewardPopup.mat',
        before: `Material:
  m_Name: RewardPopup
  m_ShaderKeywords: []
`,
        after: `Material:
  m_Name: RewardPopup
  m_ShaderKeywords: [_SOFTMASK]
`,
      },
      {
        path: 'Project_BLACK/BLACK_Unity/README.md',
        before: `# UI Art Export
`,
        after: `# UI Art Export

Updated export timestamp after the latest icon pass.
`,
      },
    ],
    metadata: {
      title: 'PR #484: Refresh exported reward popup art',
      commitMessages: [
        'PR description: Art-only export refresh before Friday build.',
        'chore: update exported popup assets',
      ],
      reviewProfile: {
        id: 'unity_csharp',
        label: 'Unity / C#',
        source: 'detected',
      },
      shapedScope: {
        rawFileCount: 3,
        reviewUnitCount: 1,
        classCounts: {
          deep: 0,
          structural: 0,
          shallow: 1,
          collapsed: 2,
          skip: 0,
        },
      },
    },
    golden: {
      minIssues: 0,
      maxIssues: 0,
      minRiskLevel: 'low',
      maxRecommendations: 2,
      maxNonIssueRecommendations: 2,
      maxSummarySentences: 4,
    },
  },
].map((fixture) => enrichFixtureDefinition(fixture));

const SNAPSHOT_FIXTURES = loadSnapshotFixtures();
const FIXTURES = [...STATIC_FIXTURES, ...SNAPSHOT_FIXTURES];
const duplicateFixtureIds = FIXTURES
  .map((fixture) => fixture.id)
  .filter((id, index, array) => array.indexOf(id) !== index);

if (duplicateFixtureIds.length > 0) {
  throw new Error(`Duplicate review harness fixture ids: ${duplicateFixtureIds.join(', ')}`);
}

function resolveFixtures({ fixtureIds = null, fixtureSet = null, surface = null } = {}) {
  const normalizedFixtureIds = Array.isArray(fixtureIds)
    ? fixtureIds.map((entry) => String(entry || '').trim()).filter(Boolean)
    : null;
  const normalizedFixtureSet = fixtureSet ? normalizeFixtureSet(fixtureSet) : null;
  const normalizedSurface = surface ? normalizeFixtureSurface(surface) : null;

  return FIXTURES.filter((fixture) => {
    if (normalizedFixtureIds && normalizedFixtureIds.length > 0 && !normalizedFixtureIds.includes(fixture.id)) {
      return false;
    }
    if (normalizedFixtureSet && fixture.fixtureSet !== normalizedFixtureSet) {
      return false;
    }
    if (normalizedSurface && fixture.surface !== normalizedSurface) {
      return false;
    }
    return true;
  });
}

function buildFixtureContext(fixture) {
  const filePaths = Array.isArray(fixture?.files) ? fixture.files.map((file) => file.path) : [];
  const lineChanges = estimateLineChanges(fixture?.files || []);
  const diff = reviewService.generateDiffFromFiles(fixture?.files || []);
  const context = {
    fileCount: Array.isArray(fixture?.files) ? fixture.files.length : 0,
    diffChars: diff.length,
    totalAdditions: lineChanges.totalAdditions,
    totalDeletions: lineChanges.totalDeletions,
    highRiskHint: inferFixtureHighRiskHint(fixture),
    recommendationBudget: estimateRecommendationBudget(Array.isArray(fixture?.files) ? fixture.files.length : 0),
  };
  const scenario = buildScenarioDescriptor(context);
  context.sizeClass = scenario.sizeClass;
  context.riskClass = scenario.riskClass;
  context.scenarioKey = scenario.key;

  return {
    filePaths,
    lineChanges,
    diff,
    context,
    scenario,
  };
}

function buildHarnessPromptMetadata(fixture, {
  qualityMode = 'auto',
  promptMetadataOverrides = null,
} = {}) {
  const { lineChanges } = buildFixtureContext(fixture);
  const metadata = fixture?.metadata && typeof fixture.metadata === 'object' ? fixture.metadata : {};
  const overrides = promptMetadataOverrides && typeof promptMetadataOverrides === 'object' && !Array.isArray(promptMetadataOverrides)
    ? promptMetadataOverrides
    : {};
  const mergedMetadata = {
    ...metadata,
    ...overrides,
  };

  return {
    ...mergedMetadata,
    reviewProfile: resolveHarnessReviewProfile(mergedMetadata.reviewProfile || null, fixture?.files || []),
    fileCount: Array.isArray(fixture?.files) ? fixture.files.length : 0,
    totalAdditions: lineChanges.totalAdditions,
    totalDeletions: lineChanges.totalDeletions,
    qualityMode,
  };
}

async function resolveHarnessPromptMetadata(fixture, {
  qualityMode = 'auto',
  promptMetadataOverrides = null,
  promptContext = null,
} = {}) {
  const metadata = buildHarnessPromptMetadata(fixture, {
    qualityMode,
    promptMetadataOverrides,
  });
  const promptContextConfig = (promptContext && typeof promptContext === 'object' && !Array.isArray(promptContext))
    ? promptContext
    : null;
  if (promptContextConfig?.enabled !== true) {
    return metadata;
  }

  const fixtureMetadata = fixture?.metadata && typeof fixture.metadata === 'object' ? fixture.metadata : {};
  const resolvedSignals = await reviewService.__testing.collectPromptContextSignals(
    resolveHarnessProjectPath(fixture),
    {
      reviewType: normalizeFixtureSurface(fixture?.surface),
      queuedCommitShas: [
        fixtureMetadata.headSha,
        fixtureMetadata.mergeBaseSha,
      ].filter((value) => typeof value === 'string' && value.trim()),
      mergeBaseSha: fixtureMetadata.mergeBaseSha || null,
      headSha: fixtureMetadata.headSha || null,
      verificationStatus: fixtureMetadata.verificationStatus || null,
      requestedReviewers: fixtureMetadata.requestedReviewers || [],
      assignees: fixtureMetadata.assignees || [],
      reviewThreads: fixtureMetadata.reviewThreads || [],
      contextFiles: Array.isArray(fixture?.files) ? fixture.files : [],
      cacheProjectId: promptContextConfig.cacheProjectId || fixtureMetadata.cacheProjectId || null,
      reviewProfile: metadata.reviewProfile || null,
      sameHashOnly: promptContextConfig.sameHashOnly !== false,
      allowGuardedCrossHashHints: promptContextConfig.allowGuardedCrossHashHints !== false,
    }
  ).catch(() => null);

  if (!resolvedSignals || typeof resolvedSignals !== 'object') {
    return metadata;
  }

  return {
    ...metadata,
    commitMessages: Array.isArray(resolvedSignals.commitMessages) ? resolvedSignals.commitMessages : metadata.commitMessages,
    queuedCommitShas: Array.isArray(resolvedSignals.queuedCommitShas) ? resolvedSignals.queuedCommitShas : metadata.queuedCommitShas,
    verificationStatus: resolvedSignals.verificationStatus || metadata.verificationStatus,
    requestedReviewers: Array.isArray(resolvedSignals.requestedReviewers) ? resolvedSignals.requestedReviewers : metadata.requestedReviewers,
    assignees: Array.isArray(resolvedSignals.assignees) ? resolvedSignals.assignees : metadata.assignees,
    reviewThreads: Array.isArray(resolvedSignals.reviewThreads) ? resolvedSignals.reviewThreads : metadata.reviewThreads,
    priorFindingHints: Array.isArray(resolvedSignals.priorFindingHints) ? resolvedSignals.priorFindingHints : metadata.priorFindingHints,
    fileRiskContext: Array.isArray(resolvedSignals.fileRiskContext) ? resolvedSignals.fileRiskContext : metadata.fileRiskContext,
    claudeConventions: Array.isArray(resolvedSignals.claudeConventions) ? resolvedSignals.claudeConventions : metadata.claudeConventions,
    projectMetadata: resolvedSignals.projectMetadata || metadata.projectMetadata,
    dismissedPatterns: Array.isArray(resolvedSignals.dismissedPatterns) ? resolvedSignals.dismissedPatterns : metadata.dismissedPatterns,
    additionalPromptContextBlocks: [
      ...(Array.isArray(metadata.additionalPromptContextBlocks) ? metadata.additionalPromptContextBlocks : []),
      ...(Array.isArray(resolvedSignals.additionalBlocks) ? resolvedSignals.additionalBlocks : []),
    ],
  };
}

function summarizeLocalVerification(result = null) {
  const localVerification = result?.localVerification;
  const bundleEntries = Array.isArray(localVerification?.bundleEntries) ? localVerification.bundleEntries : [];
  const bundleEntryCount = bundleEntries.length;
  const suppressedCount = bundleEntries.filter((entry) => String(entry?.suppressionReason || '').trim()).length;
  const activeEntries = bundleEntries.filter((entry) => !String(entry?.suppressionReason || '').trim());
  const productionPathCount = activeEntries.filter((entry) => entry?.productionPath === true).length;
  return {
    enabled: localVerification?.enabled === true,
    providerId: localVerification?.providerId || null,
    bundleEntryCount,
    suppressedCount,
    activeEntryCount: activeEntries.length,
    productionPathCount,
    suppressionRate: bundleEntryCount > 0 ? (suppressedCount / bundleEntryCount) : null,
    productionPathRate: activeEntries.length > 0 ? (productionPathCount / activeEntries.length) : null,
  };
}

function slugifyRepositoryName(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function resolveHarnessProjectPath(fixture) {
  const metadata = fixture?.metadata && typeof fixture.metadata === 'object' ? fixture.metadata : {};
  const explicitProjectPath = typeof metadata.projectPath === 'string' ? metadata.projectPath.trim() : '';
  if (explicitProjectPath) return explicitProjectPath;

  const repositoryFullName = String(metadata.repositoryFullName || '').trim();
  const repoName = repositoryFullName.split('/').pop() || '';
  const fixtureSet = String(fixture?.fixtureSet || '').trim();

  const candidateEnvKeys = [
    repositoryFullName ? `ATLAS_REVIEW_HARNESS_${slugifyRepositoryName(repositoryFullName)}_PATH` : '',
    repoName ? `ATLAS_REVIEW_HARNESS_${slugifyRepositoryName(repoName)}_PATH` : '',
    fixtureSet ? `ATLAS_REVIEW_HARNESS_${slugifyRepositoryName(fixtureSet)}_PATH` : '',
    fixtureSet === 'project_black_real_prs' ? 'ATLAS_REVIEW_HARNESS_PROJECT_BLACK_PATH' : '',
    'ATLAS_REVIEW_HARNESS_PROJECT_PATH',
  ].filter(Boolean);

  for (const envKey of candidateEnvKeys) {
    const value = String(process.env[envKey] || '').trim();
    if (value) return value;
  }

  return '';
}

function estimateHarnessReviewSizeHint(file = {}) {
  const before = typeof file?.before === 'string' ? file.before : '';
  const after = typeof file?.after === 'string' ? file.after : '';
  return Math.max(before.length, after.length, Math.abs(after.length - before.length));
}

function inferHarnessFileStatus(file = {}) {
  const before = typeof file?.before === 'string' ? file.before : null;
  const after = typeof file?.after === 'string' ? file.after : null;
  if (!before && after) return 'A';
  if (before && !after) return 'D';
  return 'M';
}

function buildHarnessAgenticFileHints(files = []) {
  return (Array.isArray(files) ? files : [])
    .filter((file) => file && typeof file.path === 'string' && file.path.trim())
    .map((file) => ({
      path: file.path,
      status: inferHarnessFileStatus(file),
      reviewSizeHint: estimateHarnessReviewSizeHint(file),
      profileClass: file.profileClass || null,
      memberPaths: Array.isArray(file.memberPaths) ? file.memberPaths : [file.path],
    }));
}

// ── Scoring logic ────────────────────────────────────────────────────

/**
 * Score a single review result against its golden expectations.
 * Returns a score object with pass/fail and breakdown.
 */
function scoreFixture(review, golden, benchmarkDimensions = {}) {
  const checks = [];
  const recommendations = safeRecommendations(review);
  const issueRecs = recommendations.filter(r => r.type === 'issue');
  const candidateFindings = Array.isArray(review?.candidateFindings) ? review.candidateFindings : [];
  const promotedCandidateCount = candidateFindings.filter((candidate) => candidate?.promotedFromCandidate === true).length;
  const remainingCandidateCount = Math.max(0, candidateFindings.length - promotedCandidateCount);
  const commentEligibleIssueCount = issueRecs.filter((r) => r?.commentEligible === true).length;
  const commentEligibilityStats = review?.stats?.commentEligibility
    && typeof review.stats.commentEligibility === 'object'
    ? review.stats.commentEligibility
    : null;
  const withheldFindings = Math.max(
    0,
    Number(commentEligibilityStats?.withheldFindings)
    || Math.max(0, issueRecs.length - commentEligibleIssueCount)
  );
  const totalCoverageFiles = Math.max(
    0,
    Number(review?.stats?.filesTotal)
    || Number(review?.stats?.totalChangedFiles)
    || 0
  );
  const deepReviewedFiles = Math.max(
    0,
    Number(review?.stats?.filesDeepReviewed)
    || Number(review?.stats?.deepReviewedFiles)
    || Number(review?.stats?.filesAnalyzed)
    || totalCoverageFiles
  );
  const deepCoverageRate = totalCoverageFiles > 0
    ? Math.min(1, deepReviewedFiles / totalCoverageFiles)
    : 1;
  const verificationLines = Array.isArray(review?.verificationStatus?.lines)
    ? review.verificationStatus.lines.filter((line) => typeof line === 'string' && line.trim())
    : [];
  const verificationSummary = (
    typeof review?.verificationStatus?.summary === 'string' && review.verificationStatus.summary.trim()
      ? review.verificationStatus.summary.trim()
      : verificationLines[0] || ''
  );
  const candidateCorpusParts = candidateFindings
    .map((candidate) => `${candidate?.title || ''} ${candidate?.description || ''}`)
    .filter(Boolean);
  const candidateCorpus = candidateCorpusParts.join(' ').toLowerCase();
  const findingsCorpusParts = [
    review.summary,
    ...recommendations.map((entry) => `${entry?.title || ''} ${entry?.description || ''}`),
    ...candidateCorpusParts,
  ].filter(Boolean);

  // 1. Keyword mentions (case-insensitive across summary + recommendations)
  if (golden.mustMentionKeywords?.length) {
    const corpus = [
      review.summary,
      ...recommendations.map(r => `${r.title} ${r.description}`),
    ].join(' ').toLowerCase();
    const semanticBugClasses = Array.from(new Set(
      [
        benchmarkDimensions?.bugClass,
        ...(Array.isArray(golden.mustMatchBugClasses) ? golden.mustMatchBugClasses : []),
      ].map((entry) => String(entry || '').trim()).filter(Boolean)
    ));
    const semanticMatch = semanticBugClasses.length > 0
      ? signalMatchesHistoricalBugClass(
          [
            review.summary,
            ...recommendations.map((entry) => `${entry?.title || ''} ${entry?.description || ''}`),
          ].join(' '),
          semanticBugClasses
        )
      : false;

    for (const kw of golden.mustMentionKeywords) {
      const found = corpus.includes(kw.toLowerCase()) || semanticMatch;
      checks.push({
        name: `mentions "${kw}"`,
        pass: found,
        detail: found
          ? (corpus.includes(kw.toLowerCase()) ? 'found' : `matched semantic bug class (${semanticBugClasses.join(', ')})`)
          : 'not found in summary or recommendations',
      });
    }
  }

  if (golden.mustMentionKeywordsInCandidates?.length) {
    for (const kw of golden.mustMentionKeywordsInCandidates) {
      const found = candidateCorpus.includes(kw.toLowerCase());
      checks.push({
        name: `candidate mentions "${kw}"`,
        pass: found,
        detail: found ? 'found' : 'not found in candidate findings',
      });
    }
  }

  if (golden.mustMatchBugClassesInCandidates?.length) {
    for (const bugClass of golden.mustMatchBugClassesInCandidates) {
      const found = candidateFindings.some((candidate) => (
        signalMatchesHistoricalBugClass(
          `${candidate?.title || ''} ${candidate?.description || ''}`,
          [bugClass]
        )
      ));
      checks.push({
        name: `candidate matches bug class "${bugClass}"`,
        pass: found,
        detail: found ? 'matched semantic bug class' : 'not found in candidate findings',
      });
    }
  }

  if (golden.mustMatchAnyBugClassesInCandidates?.length) {
    const matchedBugClass = golden.mustMatchAnyBugClassesInCandidates.find((bugClass) => (
      candidateFindings.some((candidate) => (
        signalMatchesHistoricalBugClass(
          `${candidate?.title || ''} ${candidate?.description || ''}`,
          [bugClass]
        )
      ))
    ));
    checks.push({
      name: `candidate matches one of bug classes (${golden.mustMatchAnyBugClassesInCandidates.join(', ')})`,
      pass: Boolean(matchedBugClass),
      detail: matchedBugClass
        ? `matched semantic bug class (${matchedBugClass})`
        : 'not found in candidate findings',
    });
  }

  if (golden.mustMatchAnyBugClassesInFindings?.length) {
    const matchedBugClass = golden.mustMatchAnyBugClassesInFindings.find((bugClass) => (
      signalMatchesHistoricalBugClass(findingsCorpusParts.join(' '), [bugClass])
    ));
    checks.push({
      name: `review matches one of bug classes (${golden.mustMatchAnyBugClassesInFindings.join(', ')})`,
      pass: Boolean(matchedBugClass),
      detail: matchedBugClass
        ? `matched semantic bug class (${matchedBugClass})`
        : 'not found in recommendations or candidate findings',
    });
  }

  // 2. Minimum issue count
  if (golden.minIssues != null) {
    const pass = issueRecs.length >= golden.minIssues;
    checks.push({
      name: `minIssues >= ${golden.minIssues}`,
      pass,
      detail: `found ${issueRecs.length}`,
    });
  }

  // 3. Maximum issue count (false-positive control)
  if (golden.maxIssues != null) {
    const pass = issueRecs.length <= golden.maxIssues;
    checks.push({
      name: `maxIssues <= ${golden.maxIssues}`,
      pass,
      detail: `found ${issueRecs.length}`,
    });
  }

  // 4. Minimum high/critical severity
  if (golden.minHighSeverity != null) {
    const highCount = recommendations.filter(
      r => r.severity === 'high' || r.severity === 'critical'
    ).length;
    const pass = highCount >= golden.minHighSeverity;
    checks.push({
      name: `minHighSeverity >= ${golden.minHighSeverity}`,
      pass,
      detail: `found ${highCount}`,
    });
  }

  // 5. Minimum overall risk level
  if (golden.minRiskLevel) {
    const required = RISK_ORDER.indexOf(golden.minRiskLevel);
    const actual = RISK_ORDER.indexOf(review.riskLevel);
    const pass = actual >= required;
    checks.push({
      name: `riskLevel >= ${golden.minRiskLevel}`,
      pass,
      detail: `got ${review.riskLevel}`,
    });
  }

  // 6. Must flag specific files
  if (golden.mustFlagFiles?.length) {
    const flaggedFiles = new Set(recommendations.map(r => r.file).filter(Boolean));
    for (const file of golden.mustFlagFiles) {
      const found = flaggedFiles.has(file);
      checks.push({
        name: `flags file "${file}"`,
        pass: found,
        detail: found ? 'found' : `not in flagged files: [${[...flaggedFiles].join(', ')}]`,
      });
    }
  }

  // 7. Recommendation verbosity budget
  if (golden.maxRecommendations != null) {
    const pass = recommendations.length <= golden.maxRecommendations;
    checks.push({
      name: `maxRecommendations <= ${golden.maxRecommendations}`,
      pass,
      detail: `found ${recommendations.length}`,
    });
  }

  // 8. Non-issue recommendation budget
  if (golden.maxNonIssueRecommendations != null) {
    const nonIssueCount = recommendations.filter((r) => r.type !== 'issue').length;
    const pass = nonIssueCount <= golden.maxNonIssueRecommendations;
    checks.push({
      name: `maxNonIssueRecommendations <= ${golden.maxNonIssueRecommendations}`,
      pass,
      detail: `found ${nonIssueCount}`,
    });
  }

  // 9. Issue evidence quality - file references
  if (golden.minIssueWithFileRatio != null) {
    const withFile = issueRecs.filter((r) => typeof r.file === 'string' && r.file.trim()).length;
    const actualRatio = ratio(withFile, issueRecs.length);
    const pass = actualRatio >= golden.minIssueWithFileRatio;
    checks.push({
      name: `issueFileRatio >= ${golden.minIssueWithFileRatio}`,
      pass,
      detail: `got ${actualRatio.toFixed(2)} (${withFile}/${issueRecs.length || 0})`,
    });
  }

  // 10. Issue evidence quality - line references
  if (golden.minIssueWithLineRatio != null) {
    const withLine = issueRecs.filter(
      (r) => Number.isFinite(Number(r.line)) && Number(r.line) > 0
    ).length;
    const actualRatio = ratio(withLine, issueRecs.length);
    const pass = actualRatio >= golden.minIssueWithLineRatio;
    checks.push({
      name: `issueLineRatio >= ${golden.minIssueWithLineRatio}`,
      pass,
      detail: `got ${actualRatio.toFixed(2)} (${withLine}/${issueRecs.length || 0})`,
    });
  }

  // 11. Actionability for issues/suggestions
  if (golden.minActionableRatio != null) {
    const actionablePool = recommendations.filter(
      (r) => r.type === 'issue' || r.type === 'suggestion'
    );
    const actionableCount = actionablePool.filter(hasActionableDirection).length;
    const actualRatio = ratio(actionableCount, actionablePool.length);
    const pass = actualRatio >= golden.minActionableRatio;
    checks.push({
      name: `actionableRatio >= ${golden.minActionableRatio}`,
      pass,
      detail: `got ${actualRatio.toFixed(2)} (${actionableCount}/${actionablePool.length || 0})`,
    });
  }

  // 12. High severity impact language
  if (golden.requireImpactForHighSeverity) {
    const highSeverity = recommendations.filter(
      (r) => r.severity === 'high' || r.severity === 'critical'
    );
    const withImpact = highSeverity.filter((r) => IMPACT_RE.test(`${r.title || ''} ${r.description || ''}`));
    const pass = withImpact.length === highSeverity.length;
    checks.push({
      name: 'highSeverityImpactLanguage',
      pass,
      detail: `with impact ${withImpact.length}/${highSeverity.length}`,
    });
  }

  // 13. Comment-eligible issue count
  if (golden.minCommentEligibleIssues != null) {
    const pass = commentEligibleIssueCount >= golden.minCommentEligibleIssues;
    checks.push({
      name: `minCommentEligibleIssues >= ${golden.minCommentEligibleIssues}`,
      pass,
      detail: `found ${commentEligibleIssueCount}`,
    });
  }

  // 14. Withheld findings ceiling
  if (golden.maxWithheldFindings != null) {
    const pass = withheldFindings <= golden.maxWithheldFindings;
    checks.push({
      name: `maxWithheldFindings <= ${golden.maxWithheldFindings}`,
      pass,
      detail: `found ${withheldFindings}`,
    });
  }

  // 15. Deep coverage rate
  if (golden.minDeepCoverageRate != null) {
    const pass = deepCoverageRate >= golden.minDeepCoverageRate;
    checks.push({
      name: `deepCoverageRate >= ${golden.minDeepCoverageRate}`,
      pass,
      detail: `got ${deepCoverageRate.toFixed(2)} (${deepReviewedFiles}/${totalCoverageFiles || deepReviewedFiles})`,
    });
  }

  // 16. Verification summary presence
  if (golden.requireVerificationSummary) {
    checks.push({
      name: 'verificationSummaryPresent',
      pass: Boolean(verificationSummary),
      detail: verificationSummary ? 'present' : 'missing',
    });
  }

  // 17. Summary verbosity
  if (golden.maxSummarySentences != null) {
    const sentenceCount = countSummarySentences(review.summary);
    const pass = sentenceCount <= golden.maxSummarySentences;
    checks.push({
      name: `summarySentences <= ${golden.maxSummarySentences}`,
      pass,
      detail: `found ${sentenceCount}`,
    });
  }

  if (golden.minCandidateFindings != null) {
    const pass = candidateFindings.length >= golden.minCandidateFindings;
    checks.push({
      name: `minCandidateFindings >= ${golden.minCandidateFindings}`,
      pass,
      detail: `found ${candidateFindings.length}`,
    });
  }

  if (golden.minPromotedCandidateFindings != null) {
    const pass = promotedCandidateCount >= golden.minPromotedCandidateFindings;
    checks.push({
      name: `minPromotedCandidateFindings >= ${golden.minPromotedCandidateFindings}`,
      pass,
      detail: `found ${promotedCandidateCount}`,
    });
  }

  if (golden.maxRemainingCandidateFindings != null) {
    const pass = remainingCandidateCount <= golden.maxRemainingCandidateFindings;
    checks.push({
      name: `maxRemainingCandidateFindings <= ${golden.maxRemainingCandidateFindings}`,
      pass,
      detail: `found ${remainingCandidateCount}`,
    });
  }

  const passed = checks.filter(c => c.pass).length;
  const total = checks.length;

  return {
    pass: passed === total,
    score: total > 0 ? passed / total : 1,
    passed,
    total,
    checks,
  };
}

// ── Harness runner ───────────────────────────────────────────────────

/**
 * Run the quality harness against all fixtures (or a subset).
 * @param {Object} [options]
 * @param {string[]} [options.fixtureIds] - Run only these fixtures
 * @param {string|null} [options.fixtureSet] - Run only fixtures from one benchmark set
 * @param {'changeset'|'pr_review'|'branch_review'|'workspace_review'|null} [options.surface] - Run only one review surface
 * @param {boolean} [options.dryRun] - Build prompts but don't call AI
 * @param {'auto'|'v1'|'v2'} [options.qualityMode] - Force review quality mode
 * @param {Object|null} [options.promptMetadataOverrides] - Extra prompt metadata merged into all fixture prompts
 * @param {string|null} [options.reviewModelStrategy] - Optional routing strategy override
 * @param {Object|null} [options.reviewModelAdaptive] - Optional adaptive threshold override
 * @param {Object|null} [options.reviewModelRollout] - Optional rollout override
 * @param {Object|null} [options.reviewModelCustom] - Optional per-phase custom model map
 * @param {'standard'|'agentic_discovery'|null} [options.prReviewMode] - Optional PR pipeline mode override
 * @param {string|null} [options.preferredProviderId] - Optional provider override for benchmark runs
 * @returns {Promise<Object>} Harness results
 */
async function runHarness(options = {}) {
  const {
    fixtureIds,
    fixtureSet = null,
    surface = null,
    dryRun = false,
    qualityMode = 'auto',
    promptMetadataOverrides = null,
    reviewModelStrategy = null,
    reviewModelAdaptive = null,
    reviewModelRollout = null,
    reviewModelCustom = null,
    prReviewMode = null,
    pipelineFeatures = null,
    promptContext = null,
    preferredProviderId = null,
  } = options;

  // Filter fixtures
  const fixtures = resolveFixtures({ fixtureIds, fixtureSet, surface });

  if (!fixtures.length) {
    return { error: 'No matching fixtures found', results: [] };
  }

  const normalizedStrategy = normalizeStrategyValue(reviewModelStrategy);
  const routingConfig = normalizedStrategy
    ? {
      strategy: normalizedStrategy,
      customModels: (reviewModelCustom && typeof reviewModelCustom === 'object' && !Array.isArray(reviewModelCustom))
        ? reviewModelCustom
        : {},
      adaptive: (reviewModelAdaptive && typeof reviewModelAdaptive === 'object' && !Array.isArray(reviewModelAdaptive))
        ? reviewModelAdaptive
        : {},
      rollout: (reviewModelRollout && typeof reviewModelRollout === 'object' && !Array.isArray(reviewModelRollout))
        ? reviewModelRollout
        : {},
    }
    : null;

  // Ensure we have a provider for live runs; for dry runs, provider is optional.
  let providerCandidates = [];
  let providerData = null;
  if (!dryRun || routingConfig) {
    providerCandidates = await providerService.getReviewProviderCandidatesWithKeys({
      preferredProviderId,
    });
    providerData = providerCandidates[0] || null;
    if (!providerData && !dryRun) {
      return { error: 'No active AI provider configured', results: [] };
    }
  }

  const results = [];
  const startTime = Date.now();

  for (const fixture of fixtures) {
    const fixtureStart = Date.now();
    const {
      filePaths,
      lineChanges,
      diff,
      context: fixtureContext,
      scenario,
    } = buildFixtureContext(fixture);

    const routingDecision = routingConfig && providerData
      ? reviewService.__testing.resolveEffectiveReviewModel(
        providerData,
        'review',
        routingConfig,
        {
          fileCount: fixtureContext.fileCount,
          diffChars: fixtureContext.diffChars,
          highRiskHints: fixtureContext.highRiskHint,
          riskLevel: fixture.golden?.minRiskLevel || null,
          reviewType: 'harness',
          reviewId: fixture.id,
          projectId: 'harness',
        }
      )
      : null;
    const requestModel = routingDecision?.model
      || providerData?.provider?.model
      || null;

    const promptMetadata = await resolveHarnessPromptMetadata(fixture, {
      qualityMode,
      promptMetadataOverrides,
      promptContext,
    });
    const effectivePrReviewMode = fixture.surface === 'pr_review'
      ? (
        prReviewMode === 'agentic_discovery'
        || pipelineFeatures?.terminalLikePrReview?.enabled === true
          ? 'agentic_discovery'
          : 'standard'
      )
      : 'standard';
    const terminalLikePrReviewEnabled = effectivePrReviewMode === 'agentic_discovery';
    const harnessAgenticFileHints = buildHarnessAgenticFileHints(fixture.files || []);
    let deterministicEvidence = null;
    if (pipelineFeatures?.unitySemanticVerifier?.enabled === true) {
      deterministicEvidence = await runUnitySemanticVerifier(resolveHarnessProjectPath(fixture), fixture.files || [], diff, {
        reviewProfile: promptMetadata.reviewProfile || fixture?.metadata?.reviewProfile || null,
        unitySemanticVerifier: pipelineFeatures.unitySemanticVerifier,
      }).catch(() => null);

      if (Array.isArray(deterministicEvidence?.promptFindings) && deterministicEvidence.promptFindings.length > 0) {
        promptMetadata.linterFindings = [
          ...(Array.isArray(promptMetadata.linterFindings) ? promptMetadata.linterFindings : []),
          ...deterministicEvidence.promptFindings,
        ];
      }
    }
    let prompt;
    let promptContextTelemetry;
    if (terminalLikePrReviewEnabled) {
      const behavioralHotspots = buildBehavioralHotspotDistillation(diff, harnessAgenticFileHints);
      const sortedHints = [...harnessAgenticFileHints].sort(
        (a, b) => (Number(b.reviewSizeHint) || 0) - (Number(a.reviewSizeHint) || 0)
      );
      const promptHints = sortedHints.slice(0, Math.min(sortedHints.length, 8));
      prompt = buildCliAgenticDiscoveryPrompt({
        branchName: fixture?.metadata?.branchName || 'benchmark-fixture',
        baseBranch: fixture?.metadata?.baseBranch || 'main',
        mergeBaseSha: fixture?.metadata?.mergeBaseSha || 'benchmark-base',
        headSha: fixture?.metadata?.headSha || 'benchmark-head',
        fileHints: promptHints,
        ignorePatterns: [],
        fileCount: fixtureContext.fileCount,
        reviewProfile: promptMetadata.reviewProfile || fixture?.metadata?.reviewProfile || null,
        shapedScope: promptMetadata.shapedScope || fixture?.metadata?.shapedScope || null,
        summaryHints: sortedHints.length > promptHints.length
          ? `## Additional changed files\n\n- ${sortedHints.length - promptHints.length} lower-priority changed file${sortedHints.length - promptHints.length === 1 ? '' : 's'} were omitted from the detailed list. Expand only if the top files do not explain the risky behavior.`
          : null,
        preComputedDiff: diff,
        behavioralHotspotsSummary: behavioralHotspots.summary,
      });
      promptContextTelemetry = {
        budgetChars: 0,
        usedChars: 0,
        truncated: false,
        blocks: [],
        queuedCommitShas: [],
      };
    } else {
      const builtPrompt = reviewService.buildReviewPrompt(diff, promptMetadata);
      prompt = builtPrompt.prompt;
      promptContextTelemetry = builtPrompt.promptContextTelemetry;
    }

    if (dryRun) {
      results.push({
        id: fixture.id,
        label: fixture.label,
        surface: fixture.surface,
        fixtureSet: fixture.fixtureSet,
        benchmarkDimensions: fixture.benchmarkDimensions,
        status: 'dry_run',
        promptLength: prompt.length,
        promptContextTelemetry,
        localVerification: summarizeLocalVerification(deterministicEvidence),
        golden: fixture.golden,
        score: null,
        review: null,
        context: fixtureContext,
        scenario,
        routing: routingDecision ? {
          strategy: routingDecision.strategy || null,
          effectiveStrategy: routingDecision.effectiveStrategy || null,
          model: routingDecision.model || null,
          decisionReason: routingDecision.decisionReason || null,
          fallbackReason: routingDecision.fallbackReason || null,
          budgetClass: routingDecision.budgetClass || null,
          policyVersion: routingDecision.policyVersion || null,
          thresholdProfile: routingDecision.thresholdProfile || null,
        } : null,
        prReviewMode: effectivePrReviewMode,
        durationMs: Date.now() - fixtureStart,
      });
      continue;
    }

    try {
      let finalReview;
      if (terminalLikePrReviewEnabled) {
        const projectPath = resolveHarnessProjectPath(fixture);
        const agenticOutcome = await reviewService.__testing.runCliAgenticReviewFastPath({
          reviewType: 'pr_review',
          reviewId: fixture.id,
          projectId: 'harness',
          projectPath,
          providerData,
          providerFailoverState: {
            candidates: providerCandidates,
            preferredIndex: 0,
          },
          reviewModelConfig: routingConfig || undefined,
          unavailableModels: new Set(),
          executionModeOrder: [],
          deadline: null,
          reviewTiming: null,
          emitProgress: () => {},
          markModelUsed: () => {},
          fileHintsInput: harnessAgenticFileHints,
          ignorePatterns: [],
          branchName: fixture?.metadata?.branchName || 'benchmark-fixture',
          baseBranch: fixture?.metadata?.baseBranch || 'main',
          mergeBaseSha: fixture?.metadata?.mergeBaseSha || 'benchmark-base',
          headSha: fixture?.metadata?.headSha || 'benchmark-head',
          totalAdditions: lineChanges.totalAdditions,
          totalDeletions: lineChanges.totalDeletions,
          qualityMode,
          reviewProfile: promptMetadata.reviewProfile || fixture?.metadata?.reviewProfile || null,
          reviewPolicy: promptMetadata.reviewPolicy || null,
          shapedScopeTelemetry: promptMetadata.shapedScope || fixture?.metadata?.shapedScope || null,
          diffLoader: async () => diff,
          providerCaller: callProviderForReviewWithFailover,
          discoveryMode: true,
        });
        if (!agenticOutcome?.accepted || !agenticOutcome.reviewResult) {
          throw new Error(
            `Terminal-like PR review did not produce a terminal review: ${JSON.stringify({
              accepted: agenticOutcome?.accepted === true,
              hasReviewResult: Boolean(agenticOutcome?.reviewResult),
              fallbackMeta: agenticOutcome?.fallbackMeta || null,
              selectedProviderId: agenticOutcome?.selectedProviderData?.provider?.id || null,
              modelUsed: agenticOutcome?.modelUsed || null,
            })}`
          );
        }
        finalReview = agenticOutcome.reviewResult;
        deterministicEvidence = {
          ...(deterministicEvidence && typeof deterministicEvidence === 'object' ? deterministicEvidence : {}),
          agenticDiscoveryDiagnostics: agenticOutcome.discoveryDiagnostics || null,
        };
      } else {
        const providerResult = await callProviderForReviewWithFailover(
          {
            candidates: providerCandidates,
            preferredIndex: 0,
          },
          prompt,
          {
            modelPhase: 'review',
            reviewModelConfig: routingConfig || undefined,
            modelDecisionContext: {
              fileCount: fixtureContext.fileCount,
              diffChars: diff.length,
              highRiskHints: fixtureContext.highRiskHint,
              riskLevel: fixture.golden?.minRiskLevel || null,
              reviewType: 'harness',
              reviewId: fixture.id,
              projectId: 'harness',
              files: filePaths.map((entry) => ({ path: entry })),
              fallbackFileCount: fixtureContext.fileCount,
            },
          }
        );
        const rawResult = typeof providerResult?.text === 'string'
          ? providerResult.text
          : '';

        const review = reviewService.parseReviewResponse(rawResult, {
          filePaths,
          fileCount: fixture.files.length,
          totalAdditions: lineChanges.totalAdditions,
          totalDeletions: lineChanges.totalDeletions,
          qualityMode,
        });
        let promotedReview = await runCandidateFindingPromotionPass(review, {
          historicalSignals: Array.isArray(promptMetadata.nativeHistoricalFindings)
            ? promptMetadata.nativeHistoricalFindings
            : [],
          verifyCandidate: async (candidateFinding, verifierMeta = {}) => {
            const verifierPrompt = buildHighRiskVerifierPrompt(diff, candidateFinding, {
              title: fixture?.metadata?.title || fixture.label || fixture.id,
              fileCount: fixture.files.length,
              totalAdditions: lineChanges.totalAdditions,
              totalDeletions: lineChanges.totalDeletions,
              historicalSignals: verifierMeta?.historicalSignals || [],
            });
            const verifierResult = await callProviderForReviewWithFailover(
              {
                candidates: providerCandidates,
                preferredIndex: 0,
              },
              verifierPrompt,
              {
                modelPhase: 'verifier',
                reviewModelConfig: routingConfig || undefined,
                modelDecisionContext: {
                  fileCount: fixtureContext.fileCount,
                  diffChars: diff.length,
                  highRiskHints: fixtureContext.highRiskHint,
                  riskLevel: fixture.golden?.minRiskLevel || null,
                  reviewType: 'harness_candidate_verifier',
                  reviewId: `${fixture.id}:candidate:${verifierMeta?.ordinal || 1}`,
                  projectId: 'harness',
                  files: filePaths.map((entry) => ({ path: entry })),
                  fallbackFileCount: fixtureContext.fileCount,
                },
              }
            );
            return parseHighRiskVerifierDecision(verifierResult?.text || '');
          },
        });
        if (Array.isArray(deterministicEvidence?.anchoredFindings) && deterministicEvidence.anchoredFindings.length > 0) {
          promotedReview = mergeDeterministicFindingsIntoReview(promotedReview, deterministicEvidence.anchoredFindings);
        }
        finalReview = promotedReview;
      }
      const score = scoreFixture(finalReview, fixture.golden, fixture.benchmarkDimensions);
      const precision = extractPrecisionMetricsFromStats(finalReview.stats || {});
      const findingCounts = summarizeReviewFindingCounts(finalReview);

      results.push({
        id: fixture.id,
        label: fixture.label,
        surface: fixture.surface,
        fixtureSet: fixture.fixtureSet,
        benchmarkDimensions: fixture.benchmarkDimensions,
        status: score.pass ? 'pass' : 'fail',
        score,
        review: {
          summary: finalReview.summary,
          riskLevel: finalReview.riskLevel,
          reviewTier: finalReview.stats?.reviewTier || null,
          isPartial: finalReview.stats?.isPartial === true,
          partialReason: finalReview.stats?.partialReason || null,
          firstSignalMs: finalReview.stats?.firstSignalMs != null && Number.isFinite(Number(finalReview.stats?.firstSignalMs))
            ? Number(finalReview.stats.firstSignalMs)
            : null,
          chunkCount: Number(finalReview.stats?.chunkCount || 0),
          filesDeepReviewed: Number(finalReview.stats?.filesDeepReviewed || 0),
          filesTotal: Number(finalReview.stats?.filesTotal || fixture.files.length),
          omittedFiles: Number(finalReview.stats?.omittedFiles || 0),
          reviewModelStrategy: finalReview.stats?.reviewModelStrategy || null,
          reviewModelDecisionReason: finalReview.stats?.reviewModelDecisionReason || null,
          issuesTotal: precision.issuesTotal,
          issuesDemoted: precision.issuesDemoted,
          issuesSuppressed: precision.issuesSuppressed,
          verifierSupported: precision.verifierSupported,
          verifierUnsupported: precision.verifierUnsupported,
          verifierNeedsMoreContext: precision.verifierNeedsMoreContext,
          verifierMediumEnabled: finalReview.stats?.verifierMediumEnabled === true,
          verifierMediumConsidered: Number(finalReview.stats?.verifierMediumConsidered || 0),
          verifierMediumChecked: Number(finalReview.stats?.verifierMediumChecked || 0),
          verifierMediumSkippedBudget: Number(finalReview.stats?.verifierMediumSkippedBudget || 0),
          verifierMediumGateStatus: finalReview.stats?.verifierMediumGateStatus || 'disabled',
          unsupportedIssueRate: precision.unsupportedIssueRate,
          lowEvidenceIssueRate: precision.lowEvidenceIssueRate,
          dismissedIssueRate: precision.dismissedIssueRate,
          uncorroboratedHighRiskRate: precision.uncorroboratedHighRiskRate,
          outcomeSuppressionRate: precision.outcomeSuppressionRate,
          precisionIssueSampleCount: precision.samples.precisionIssues,
          verifierSampleCount: precision.samples.verifier,
          dismissalSampleCount: precision.samples.dismissal,
          corroborationSampleCount: precision.samples.corroboration,
          suppressionSampleCount: precision.samples.suppression,
          reviewOutcomeTelemetry: precision.outcomeTelemetry,
          recommendationCount: finalReview.recommendations.length,
          issueCount: findingCounts.issueCount,
          highSeverityIssueCount: findingCounts.highSeverityIssueCount,
          commentEligibleIssueCount: findingCounts.commentEligibleIssueCount,
          withheldFindings: findingCounts.withheldFindings,
          candidateFindingCount: findingCounts.candidateFindingCount,
          promotedCandidateCount: findingCounts.promotedCandidateCount,
          remainingCandidateCount: findingCounts.remainingCandidateCount,
          supportedCandidateCount: findingCounts.supportedCandidateCount,
          agenticDiscoveryRawIssueCount: Number(finalReview.stats?.agenticDiscoveryRawIssueCount || 0),
          agenticDiscoveryRawCandidateCount: Number(finalReview.stats?.agenticDiscoveryRawCandidateCount || 0),
          agenticDiscoveryRawFindingCount: Number(finalReview.stats?.agenticDiscoveryRawFindingCount || 0),
          agenticDiscoveryExtractionMode: finalReview.stats?.agenticDiscoveryExtractionMode || null,
          agenticDiscoveryDiagnostics: deterministicEvidence?.agenticDiscoveryDiagnostics || null,
          candidateFindingPromotion: finalReview.stats?.candidateFindingPromotion || null,
          parseMode: finalReview.stats?.parseMode || 'strict_json',
          parseRecovered: finalReview.stats?.parseRecovered === true,
          recommendations: finalReview.recommendations.map(r => ({
            type: r.type,
            severity: r.severity,
            title: r.title,
            file: r.file,
            line: r.line,
            commentEligible: r.commentEligible === true,
          })),
          candidateFindings: (Array.isArray(finalReview.candidateFindings) ? finalReview.candidateFindings : []).map((candidate) => ({
            type: candidate.type,
            severity: candidate.severity,
            confidence: candidate.confidence || null,
            title: candidate.title,
            file: candidate.file,
            line: candidate.line,
            promotedFromCandidate: candidate.promotedFromCandidate === true,
            verifierDecision: candidate.verifierDecision || null,
          })),
        },
        promptLength: prompt.length,
        promptContextTelemetry,
        localVerification: summarizeLocalVerification(deterministicEvidence),
        context: fixtureContext,
        scenario,
        routing: routingDecision ? {
          strategy: routingDecision.strategy || null,
          effectiveStrategy: routingDecision.effectiveStrategy || null,
          model: requestModel || routingDecision.model || null,
          decisionReason: routingDecision.decisionReason || null,
          fallbackReason: routingDecision.fallbackReason || null,
          budgetClass: routingDecision.budgetClass || null,
          policyVersion: routingDecision.policyVersion || null,
          thresholdProfile: routingDecision.thresholdProfile || null,
        } : null,
        prReviewMode: effectivePrReviewMode,
        durationMs: Date.now() - fixtureStart,
      });
    } catch (error) {
      results.push({
        id: fixture.id,
        label: fixture.label,
        surface: fixture.surface,
        fixtureSet: fixture.fixtureSet,
        benchmarkDimensions: fixture.benchmarkDimensions,
        status: 'error',
        error: error.message,
        score: null,
        review: null,
        promptLength: prompt.length,
        promptContextTelemetry,
        localVerification: summarizeLocalVerification(deterministicEvidence),
        context: fixtureContext,
        scenario,
        routing: routingDecision ? {
          strategy: routingDecision.strategy || null,
          effectiveStrategy: routingDecision.effectiveStrategy || null,
          model: requestModel || routingDecision.model || null,
          decisionReason: routingDecision.decisionReason || null,
          fallbackReason: routingDecision.fallbackReason || null,
          budgetClass: routingDecision.budgetClass || null,
          policyVersion: routingDecision.policyVersion || null,
          thresholdProfile: routingDecision.thresholdProfile || null,
        } : null,
        prReviewMode: effectivePrReviewMode,
        durationMs: Date.now() - fixtureStart,
      });
    }
  }

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const errors = results.filter(r => r.status === 'error').length;

  return {
    summary: {
      total: results.length,
      passed,
      failed,
      errors,
      allPassed: failed === 0 && errors === 0,
      qualityMode,
      reviewModelStrategy: normalizedStrategy,
      fixtureSet: fixtureSet ? normalizeFixtureSet(fixtureSet) : null,
      surface: surface ? normalizeFixtureSurface(surface) : null,
      durationMs: Date.now() - startTime,
    },
    results,
  };
}

function isTimeoutOrDeadlineErrorMessage(message) {
  return TIMEOUT_OR_DEADLINE_RE.test(String(message || ''));
}

function percentile(values = [], percentile = 0.5) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(Math.max(0, Math.min(1, percentile)) * sorted.length) - 1)
  );
  return sorted[index];
}

function isFastPathEligible(context, adaptiveThresholds) {
  if (!context || typeof context !== 'object') return false;
  const fileCount = Number(context.fileCount) || 0;
  const diffChars = Number(context.diffChars) || 0;
  const highRiskHint = Boolean(context.highRiskHint);
  if (fileCount <= 0 || diffChars <= 0) return false;
  if (adaptiveThresholds.preferQualityOnHighRisk && highRiskHint) return false;
  return (
    fileCount <= adaptiveThresholds.fastPathMaxFiles
    && diffChars <= adaptiveThresholds.fastPathMaxDiffChars
  );
}

function createSliceAccumulator() {
  return {
    fixtures: 0,
    passed: 0,
    totalScore: 0,
    totalDurationMs: 0,
    totalRecommendations: 0,
  };
}

function finalizeSliceAccumulator(accumulator) {
  const fixtures = Number(accumulator?.fixtures || 0);
  if (fixtures <= 0) {
    return {
      fixtures: 0,
      passRate: 0,
      avgScore: 0,
      avgDurationMs: 0,
      avgRecommendations: 0,
    };
  }
  return {
    fixtures,
    passRate: (Number(accumulator?.passed || 0) / fixtures),
    avgScore: (Number(accumulator?.totalScore || 0) / fixtures),
    avgDurationMs: (Number(accumulator?.totalDurationMs || 0) / fixtures),
    avgRecommendations: (Number(accumulator?.totalRecommendations || 0) / fixtures),
  };
}

function summarizeHarnessMetrics(results = [], adaptiveConfig = null) {
  const adaptiveThresholds = normalizeAdaptiveThresholds(adaptiveConfig);
  const totalFixtures = Array.isArray(results) ? results.length : 0;
  const completed = results.filter((r) => r.status === 'pass' || r.status === 'fail');
  const errored = results.filter((r) => r.status === 'error');
  const contexts = results
    .map((result) => result?.context)
    .filter((ctx) => ctx && typeof ctx === 'object');
  const timeoutOrDeadlineErrors = errored.filter((r) => isTimeoutOrDeadlineErrorMessage(r.error)).length;
  const durations = results
    .map((r) => Number(r.durationMs))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const promptLengths = results
    .map((r) => Number(r.promptLength))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const promptContextUsedCharsSamples = results
    .map((r) => Number(r?.promptContextTelemetry?.usedChars))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const promptContextUtilizationSamples = results
    .map((r) => {
      const used = Number(r?.promptContextTelemetry?.usedChars);
      const budget = Number(r?.promptContextTelemetry?.budgetChars);
      if (!Number.isFinite(used) || !Number.isFinite(budget) || budget <= 0) return null;
      return Math.max(0, Math.min(1, used / budget));
    })
    .filter((value) => Number.isFinite(value) && value >= 0);
  const promptContextTruncatedCount = results.filter((r) => r?.promptContextTelemetry?.truncated === true).length;
  const avgDurationMs = totalFixtures > 0
    ? results.reduce((acc, r) => acc + (Number(r.durationMs) || 0), 0) / totalFixtures
    : 0;
  const durationP50Ms = percentile(durations, 0.5);
  const durationP95Ms = percentile(durations, 0.95);
  const avgPromptChars = promptLengths.length > 0
    ? promptLengths.reduce((acc, value) => acc + value, 0) / promptLengths.length
    : 0;
  const promptCharsP50 = percentile(promptLengths, 0.5);
  const promptCharsP95 = percentile(promptLengths, 0.95);
  const avgPromptContextUsedChars = promptContextUsedCharsSamples.length > 0
    ? promptContextUsedCharsSamples.reduce((acc, value) => acc + value, 0) / promptContextUsedCharsSamples.length
    : 0;
  const avgPromptContextUtilization = promptContextUtilizationSamples.length > 0
    ? promptContextUtilizationSamples.reduce((acc, value) => acc + value, 0) / promptContextUtilizationSamples.length
    : 0;
  const promptContextTruncatedRate = totalFixtures > 0
    ? (promptContextTruncatedCount / totalFixtures)
    : 0;
  const localVerificationSamples = results
    .map((r) => r?.localVerification)
    .filter((entry) => entry && typeof entry === 'object' && Number(entry.bundleEntryCount) > 0);
  const parseModeCounts = results.reduce((acc, result) => {
    const mode = typeof result?.review?.parseMode === 'string' && result.review.parseMode.trim()
      ? result.review.parseMode.trim()
      : 'unknown';
    acc[mode] = (acc[mode] || 0) + 1;
    return acc;
  }, {});
  const parseRecoveredCount = results.filter((r) => r?.review?.parseRecovered === true).length;
  const parseRecoveryRate = totalFixtures > 0 ? (parseRecoveredCount / totalFixtures) : 0;
  const strictParseRate = totalFixtures > 0
    ? ((Number(parseModeCounts.strict_json) || 0) / totalFixtures)
    : 0;
  const localVerificationCoverageRate = totalFixtures > 0
    ? (localVerificationSamples.length / totalFixtures)
    : 0;
  const localVerificationSuppressionRate = localVerificationSamples.length > 0
    ? localVerificationSamples.reduce((sum, entry) => sum + Number(entry?.suppressionRate || 0), 0) / localVerificationSamples.length
    : 0;
  const localVerificationProductionPathRate = localVerificationSamples.length > 0
    ? localVerificationSamples.reduce((sum, entry) => sum + Number(entry?.productionPathRate || 0), 0) / localVerificationSamples.length
    : 0;
  const errorRate = totalFixtures > 0 ? (errored.length / totalFixtures) : 0;
  const timeoutOrDeadlineErrorRate = totalFixtures > 0
    ? (timeoutOrDeadlineErrors / totalFixtures)
    : 0;
  const partialCount = completed.filter((r) => r.review?.isPartial || r.review?.reviewTier === 'partial').length;
  const filesOnlyCount = completed.filter((r) => r.review?.reviewTier === 'files_only').length;
  const partialRate = completed.length > 0 ? (partialCount / completed.length) : 0;
  const filesOnlyRate = completed.length > 0 ? (filesOnlyCount / completed.length) : 0;
  const fastPathEligibleCount = contexts.filter((ctx) => isFastPathEligible(ctx, adaptiveThresholds)).length;
  const deepScopePressureCount = Math.max(0, contexts.length - fastPathEligibleCount);
  const fastPathCoverageRate = contexts.length > 0 ? (fastPathEligibleCount / contexts.length) : 0;
  const deepScopePressureRate = contexts.length > 0 ? (deepScopePressureCount / contexts.length) : 0;
  const budgetEligible = completed.filter((r) => Number.isFinite(Number(r?.context?.recommendationBudget)));
  const recommendationBudgetPressureCount = budgetEligible.filter((r) => {
    const budget = Number(r?.context?.recommendationBudget) || 0;
    const recommendationCount = Number(r?.review?.recommendationCount) || 0;
    return budget > 0 && recommendationCount >= budget;
  }).length;
  const recommendationBudgetPressureRate = budgetEligible.length > 0
    ? (recommendationBudgetPressureCount / budgetEligible.length)
    : 0;
  const firstSignalSamples = completed
    .map((r) => r?.review?.firstSignalMs)
    .filter((value) => value != null && Number.isFinite(Number(value)) && Number(value) >= 0)
    .map((value) => Number(value));
  const firstSignalDataRate = completed.length > 0
    ? (firstSignalSamples.length / completed.length)
    : 0;
  const firstSignalP50Ms = percentile(firstSignalSamples, 0.5);
  const firstSignalP95Ms = percentile(firstSignalSamples, 0.95);
  const chunkCadenceSamples = completed
    .map((r) => {
      const chunkCount = Number(r?.review?.chunkCount || 0);
      const durationMs = Number(r?.durationMs || 0);
      if (!Number.isFinite(chunkCount) || chunkCount <= 0) return null;
      if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
      return chunkCount / (durationMs / 60000);
    })
    .filter((value) => Number.isFinite(value) && value >= 0);
  const chunkCadencePerMinute = chunkCadenceSamples.length > 0
    ? chunkCadenceSamples.reduce((sum, value) => sum + value, 0) / chunkCadenceSamples.length
    : 0;
  const coverageEligible = completed.filter((r) => Number.isFinite(Number(r?.review?.filesTotal)) && Number(r?.review?.filesTotal) > 0);
  const omittedCoverageRate = coverageEligible.length > 0
    ? coverageEligible.reduce((sum, r) => {
      const filesTotal = Number(r.review.filesTotal) || 0;
      const omittedFiles = Math.max(0, Number(r.review.omittedFiles) || 0);
      const omittedRatio = filesTotal > 0 ? Math.min(1, omittedFiles / filesTotal) : 0;
      return sum + omittedRatio;
    }, 0) / coverageEligible.length
    : 0;
  const deepCoverageRate = coverageEligible.length > 0
    ? Math.max(0, 1 - omittedCoverageRate)
    : 1;
  const highRiskCompleted = completed.filter((r) => Boolean(r?.context?.highRiskHint));
  const highRiskIssueCoverageCount = highRiskCompleted.filter((r) => {
    const recommendations = Array.isArray(r?.review?.recommendations) ? r.review.recommendations : [];
    return recommendations.some((rec) => rec?.type === 'issue');
  }).length;
  const highRiskIssueCoverageRate = highRiskCompleted.length > 0
    ? (highRiskIssueCoverageCount / highRiskCompleted.length)
    : 1;
  const highRiskSeverityCoverageCount = highRiskCompleted.filter((r) => {
    const recommendations = Array.isArray(r?.review?.recommendations) ? r.review.recommendations : [];
    return recommendations.some(
      (rec) => rec?.type === 'issue' && (rec?.severity === 'high' || rec?.severity === 'critical')
    );
  }).length;
  const highRiskSeverityCoverageRate = highRiskCompleted.length > 0
    ? (highRiskSeverityCoverageCount / highRiskCompleted.length)
    : 1;
  const precisionSnapshots = completed
    .map((result) => extractPrecisionMetricsFromStats(result?.review || {}));
  const unsupportedIssueEligible = precisionSnapshots.filter((snapshot) => snapshot.samples.verifier > 0);
  const lowEvidenceIssueEligible = precisionSnapshots.filter((snapshot) => snapshot.samples.precisionIssues > 0);
  const dismissedIssueEligible = precisionSnapshots.filter((snapshot) => snapshot.samples.dismissal > 0);
  const uncorroboratedHighRiskEligible = precisionSnapshots.filter((snapshot) => snapshot.samples.corroboration > 0);
  const outcomeSuppressionEligible = precisionSnapshots.filter((snapshot) => snapshot.samples.suppression > 0);
  const unsupportedIssueRate = unsupportedIssueEligible.length > 0
    ? unsupportedIssueEligible.reduce((sum, snapshot) => sum + Number(snapshot.unsupportedIssueRate || 0), 0)
      / unsupportedIssueEligible.length
    : 0;
  const lowEvidenceIssueRate = lowEvidenceIssueEligible.length > 0
    ? lowEvidenceIssueEligible.reduce((sum, snapshot) => sum + Number(snapshot.lowEvidenceIssueRate || 0), 0)
      / lowEvidenceIssueEligible.length
    : 0;
  const dismissedIssueRate = dismissedIssueEligible.length > 0
    ? dismissedIssueEligible.reduce((sum, snapshot) => sum + Number(snapshot.dismissedIssueRate || 0), 0)
      / dismissedIssueEligible.length
    : 0;
  const uncorroboratedHighRiskRate = uncorroboratedHighRiskEligible.length > 0
    ? uncorroboratedHighRiskEligible.reduce((sum, snapshot) => sum + Number(snapshot.uncorroboratedHighRiskRate || 0), 0)
      / uncorroboratedHighRiskEligible.length
    : 0;
  const outcomeSuppressionRate = outcomeSuppressionEligible.length > 0
    ? outcomeSuppressionEligible.reduce((sum, snapshot) => sum + Number(snapshot.outcomeSuppressionRate || 0), 0)
      / outcomeSuppressionEligible.length
    : 0;
  const mediumVerifierConsidered = completed.reduce(
    (sum, result) => sum + Math.max(0, Number(result?.review?.verifierMediumConsidered) || 0),
    0
  );
  const mediumVerifierChecked = completed.reduce(
    (sum, result) => sum + Math.max(0, Number(result?.review?.verifierMediumChecked) || 0),
    0
  );
  const mediumVerifierCoverageRate = mediumVerifierConsidered > 0
    ? Math.min(1, mediumVerifierChecked / mediumVerifierConsidered)
    : 1;

  const scenarioMap = new Map();
  for (const result of completed) {
    const scenario = result?.scenario || buildScenarioDescriptor(result?.context || {});
    const key = scenario?.key || 'unknown:unknown';
    const existing = scenarioMap.get(key) || createSliceAccumulator();
    existing.fixtures += 1;
    if (result.status === 'pass') existing.passed += 1;
    existing.totalScore += Number(result?.score?.score || 0);
    existing.totalDurationMs += Number(result?.durationMs || 0);
    existing.totalRecommendations += Number(result?.review?.recommendationCount || 0);
    scenarioMap.set(key, existing);
  }
  const scenarioMatrix = {};
  for (const [key, accumulator] of scenarioMap.entries()) {
    scenarioMatrix[key] = finalizeSliceAccumulator(accumulator);
  }

  const strategyMap = new Map();
  for (const result of completed) {
    const strategyKey = normalizeStrategyValue(
      result?.routing?.effectiveStrategy
      || result?.routing?.strategy
      || result?.review?.reviewModelStrategy
      || 'unknown'
    ) || 'unknown';
    const existing = strategyMap.get(strategyKey) || createSliceAccumulator();
    existing.fixtures += 1;
    if (result.status === 'pass') existing.passed += 1;
    existing.totalScore += Number(result?.score?.score || 0);
    existing.totalDurationMs += Number(result?.durationMs || 0);
    existing.totalRecommendations += Number(result?.review?.recommendationCount || 0);
    strategyMap.set(strategyKey, existing);
  }
  const strategySlices = {};
  for (const [key, accumulator] of strategyMap.entries()) {
    strategySlices[key] = finalizeSliceAccumulator(accumulator);
  }

  if (completed.length === 0) {
    return {
      fixtures: 0,
      totalFixtures,
      passRate: 0,
      avgScore: 0,
      avgRecommendations: 0,
      avgChecksPassedRatio: 0,
      errorRate,
      timeoutOrDeadlineErrorRate,
      partialRate,
      filesOnlyRate,
      avgDurationMs,
      durationP50Ms,
      durationP95Ms,
      avgPromptChars,
      promptCharsP50,
      promptCharsP95,
      avgPromptContextUsedChars,
      avgPromptContextUtilization,
      promptContextTruncatedRate,
      parseRecoveryRate,
      strictParseRate,
      parseModeCounts,
      localVerificationCoverageRate,
      localVerificationSuppressionRate,
      localVerificationProductionPathRate,
      promptContextSampleCount: promptContextUsedCharsSamples.length,
      fastPathCoverageRate,
      fastPathEligibleCount,
      deepScopePressureRate,
      deepScopePressureCount,
      recommendationBudgetPressureRate,
      recommendationBudgetPressureCount,
      firstSignalDataRate,
      firstSignalP50Ms,
      firstSignalP95Ms,
      firstSignalSampleCount: firstSignalSamples.length,
      chunkCadencePerMinute,
      chunkCadenceSampleCount: chunkCadenceSamples.length,
      omittedCoverageRate,
      deepCoverageRate,
      omittedCoverageSampleCount: coverageEligible.length,
      highRiskFixtureCount: 0,
      highRiskIssueCoverageRate: 1,
      highRiskIssueCoverageCount: 0,
      highRiskSeverityCoverageRate: 1,
      highRiskSeverityCoverageCount: 0,
      unsupportedIssueRate,
      unsupportedIssueSampleCount: unsupportedIssueEligible.length,
      lowEvidenceIssueRate,
      lowEvidenceIssueSampleCount: lowEvidenceIssueEligible.length,
      dismissedIssueRate,
      dismissedIssueSampleCount: dismissedIssueEligible.length,
      uncorroboratedHighRiskRate,
      uncorroboratedHighRiskSampleCount: uncorroboratedHighRiskEligible.length,
      outcomeSuppressionRate,
      outcomeSuppressionSampleCount: outcomeSuppressionEligible.length,
      mediumVerifierCoverageRate,
      mediumVerifierSampleCount: mediumVerifierConsidered,
      mediumVerifierCheckedCount: mediumVerifierChecked,
      scenarioMatrix: {},
      strategySlices: {},
      adaptiveThresholds,
    };
  }

  const passCount = completed.filter((r) => r.status === 'pass').length;
  const totalScore = completed.reduce((acc, r) => acc + (r.score?.score || 0), 0);
  const totalRecommendations = completed.reduce(
    (acc, r) => acc + (r.review?.recommendationCount || 0),
    0
  );
  const totalCheckRatio = completed.reduce((acc, r) => {
    const passedChecks = r.score?.passed || 0;
    const totalChecks = r.score?.total || 0;
    if (totalChecks <= 0) return acc + 1;
    return acc + (passedChecks / totalChecks);
  }, 0);

  return {
    fixtures: completed.length,
    totalFixtures,
    passRate: passCount / completed.length,
    avgScore: totalScore / completed.length,
    avgRecommendations: totalRecommendations / completed.length,
    avgChecksPassedRatio: totalCheckRatio / completed.length,
    errorRate,
    timeoutOrDeadlineErrorRate,
    partialRate,
    filesOnlyRate,
    avgDurationMs,
    durationP50Ms,
    durationP95Ms,
    avgPromptChars,
    promptCharsP50,
    promptCharsP95,
    avgPromptContextUsedChars,
    avgPromptContextUtilization,
    promptContextTruncatedRate,
    parseRecoveryRate,
    strictParseRate,
    parseModeCounts,
    localVerificationCoverageRate,
    localVerificationSuppressionRate,
    localVerificationProductionPathRate,
    promptContextSampleCount: promptContextUsedCharsSamples.length,
    fastPathCoverageRate,
    fastPathEligibleCount,
    deepScopePressureRate,
    deepScopePressureCount,
    recommendationBudgetPressureRate,
    recommendationBudgetPressureCount,
    firstSignalDataRate,
    firstSignalP50Ms,
    firstSignalP95Ms,
    firstSignalSampleCount: firstSignalSamples.length,
    chunkCadencePerMinute,
    chunkCadenceSampleCount: chunkCadenceSamples.length,
    omittedCoverageRate,
    deepCoverageRate,
    omittedCoverageSampleCount: coverageEligible.length,
    highRiskFixtureCount: highRiskCompleted.length,
    highRiskIssueCoverageRate,
    highRiskIssueCoverageCount,
    highRiskSeverityCoverageRate,
    highRiskSeverityCoverageCount,
    unsupportedIssueRate,
    unsupportedIssueSampleCount: unsupportedIssueEligible.length,
    lowEvidenceIssueRate,
    lowEvidenceIssueSampleCount: lowEvidenceIssueEligible.length,
    dismissedIssueRate,
    dismissedIssueSampleCount: dismissedIssueEligible.length,
    uncorroboratedHighRiskRate,
    uncorroboratedHighRiskSampleCount: uncorroboratedHighRiskEligible.length,
    outcomeSuppressionRate,
    outcomeSuppressionSampleCount: outcomeSuppressionEligible.length,
    mediumVerifierCoverageRate,
    mediumVerifierSampleCount: mediumVerifierConsidered,
    mediumVerifierCheckedCount: mediumVerifierChecked,
    scenarioMatrix,
    strategySlices,
    adaptiveThresholds,
  };
}

function buildTuningSignals(comparison, adaptiveConfig = null, tuningTargets = null) {
  const adaptiveThresholds = normalizeAdaptiveThresholds(adaptiveConfig);
  const targets = normalizeTuningTargets(tuningTargets);
  const improvedMetrics = comparison?.improved?.metrics || {};
  const completedFixtures = Number(improvedMetrics.fixtures) || 0;

  const fastPathCoverageRate = Number(improvedMetrics.fastPathCoverageRate) || 0;
  const deepScopePressureRate = Number(improvedMetrics.deepScopePressureRate) || 0;
  const deepCoverageRate = Number(improvedMetrics.deepCoverageRate) || 0;
  const durationP95Ms = Number(improvedMetrics.durationP95Ms) || 0;
  const recommendationBudgetPressureRate = Number(improvedMetrics.recommendationBudgetPressureRate) || 0;
  const highRiskIssueCoverageRate = Number(improvedMetrics.highRiskIssueCoverageRate) || 0;
  const highRiskFixtureCount = Number(improvedMetrics.highRiskFixtureCount) || 0;
  const firstSignalDataRate = Number(improvedMetrics.firstSignalDataRate) || 0;
  const firstSignalP95Ms = Number(improvedMetrics.firstSignalP95Ms) || 0;
  const firstSignalSampleCount = Number(improvedMetrics.firstSignalSampleCount) || 0;
  const chunkCadencePerMinute = Number(improvedMetrics.chunkCadencePerMinute) || 0;
  const chunkCadenceSampleCount = Number(improvedMetrics.chunkCadenceSampleCount) || 0;

  const indicators = {
    fastPathCoverage: {
      metric: fastPathCoverageRate,
      target: `${formatRate(targets.minFastPathCoverageRate)} - ${formatRate(targets.maxFastPathCoverageRate)}`,
      status:
        fastPathCoverageRate < targets.minFastPathCoverageRate ? 'low'
          : fastPathCoverageRate > targets.maxFastPathCoverageRate ? 'high'
            : 'ok',
    },
    deepScopePressure: {
      metric: deepScopePressureRate,
      target: `<= ${formatRate(targets.maxDeepScopePressureRate)}`,
      status: deepScopePressureRate > targets.maxDeepScopePressureRate ? 'high' : 'ok',
    },
    deepCoverage: {
      metric: deepCoverageRate,
      target: `>= ${formatRate(targets.minDeepCoverageRate)}`,
      status: deepCoverageRate < targets.minDeepCoverageRate ? 'low' : 'ok',
    },
    totalLatency: {
      metric: durationP95Ms,
      target: `<= ${Math.round(targets.maxDurationP95Ms)}ms`,
      status: durationP95Ms > targets.maxDurationP95Ms ? 'high' : 'ok',
    },
    recommendationBudgetPressure: {
      metric: recommendationBudgetPressureRate,
      target: `<= ${formatRate(targets.maxRecommendationBudgetPressureRate)}`,
      status: recommendationBudgetPressureRate > targets.maxRecommendationBudgetPressureRate ? 'high' : 'ok',
    },
    highRiskIssueCoverage: {
      metric: highRiskIssueCoverageRate,
      target: `>= ${formatRate(targets.minHighRiskIssueCoverageRate)}`,
      status: highRiskFixtureCount === 0 || highRiskIssueCoverageRate >= targets.minHighRiskIssueCoverageRate
        ? 'ok'
        : 'low',
      sampleCount: highRiskFixtureCount,
    },
    firstSignalData: {
      metric: firstSignalDataRate,
      target: `>= ${formatRate(targets.minFirstSignalDataRate)}`,
      status: firstSignalDataRate < targets.minFirstSignalDataRate ? 'low' : 'ok',
    },
    firstSignalLatency: {
      metric: firstSignalP95Ms,
      target: `<= ${Math.round(targets.maxFirstSignalP95Ms)}ms`,
      status: firstSignalSampleCount > 0 && firstSignalP95Ms > targets.maxFirstSignalP95Ms ? 'high' : 'ok',
      sampleCount: firstSignalSampleCount,
    },
    chunkCadence: {
      metric: chunkCadencePerMinute,
      target: `>= ${targets.minChunkCadencePerMinute.toFixed(2)} chunks/min`,
      status: chunkCadenceSampleCount > 0 && chunkCadencePerMinute < targets.minChunkCadencePerMinute ? 'low' : 'ok',
      sampleCount: chunkCadenceSampleCount,
    },
  };

  const recommendations = [];
  if (completedFixtures < DEFAULT_ROLLOUT_GATE_THRESHOLDS.minCompletedFixtures) {
    recommendations.push(
      `Collect at least ${DEFAULT_ROLLOUT_GATE_THRESHOLDS.minCompletedFixtures} completed fixtures before promoting defaults (currently ${completedFixtures}).`
    );
  }
  if (indicators.fastPathCoverage.status === 'low') {
    recommendations.push(
      'Fast-path coverage is below target; consider increasing adaptive fast-path thresholds to improve throughput.'
    );
  } else if (indicators.fastPathCoverage.status === 'high') {
    recommendations.push(
      'Fast-path coverage is above target; consider tightening adaptive fast-path thresholds to preserve quality.'
    );
  }
  if (indicators.deepScopePressure.status === 'high') {
    recommendations.push(
      'Deep-scope pressure is high; consider increasing fast-path thresholds or reducing focused-review depth.'
    );
  }
  if (indicators.deepCoverage.status === 'low') {
    recommendations.push(
      'Deep coverage is below target; increase focused-review expansion budget or run targeted follow-up passes.'
    );
  }
  if (indicators.totalLatency.status === 'high') {
    recommendations.push(
      'Total latency p95 is above target; increase bounded parallelism or reduce oversized focused-review payloads.'
    );
  }
  if (indicators.recommendationBudgetPressure.status === 'high') {
    recommendations.push(
      'Recommendation budget pressure is high; tune recommendation caps or reduce low-signal findings in synthesis.'
    );
  }
  if (indicators.highRiskIssueCoverage.status === 'low') {
    recommendations.push(
      'High-risk fixture coverage is below target; tighten fast-path thresholds or strengthen high-risk issue extraction.'
    );
  }
  if (indicators.firstSignalData.status === 'low') {
    recommendations.push(
      'First-signal coverage is low; ensure review runs emit firstSignalMs stats for throughput tracking.'
    );
  }
  if (indicators.firstSignalLatency.status === 'high') {
    recommendations.push(
      'First-signal latency p95 is above target; increase parallel chunk throughput or reduce deep-review scope.'
    );
  }
  if (indicators.chunkCadence.status === 'low') {
    recommendations.push(
      'Chunk cadence is below target; tune chunk concurrency and file-prep parallelism for large reviews.'
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Tuning signals are within target ranges; keep current adaptive thresholds.');
  }

  return {
    adaptiveThresholds,
    targets,
    indicators,
    recommendations,
  };
}

function formatRate(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function evaluateRolloutGate(comparison, gateThresholds = {}) {
  const thresholds = {
    ...DEFAULT_ROLLOUT_GATE_THRESHOLDS,
    ...(gateThresholds && typeof gateThresholds === 'object' ? gateThresholds : {}),
  };

  const baselineMetrics = comparison?.baseline?.metrics || {};
  const improvedMetrics = comparison?.improved?.metrics || {};
  const delta = comparison?.delta || {};

  const completedFixtures = Number(improvedMetrics.fixtures) || 0;
  const passRateDelta = Number.isFinite(delta.passRate)
    ? delta.passRate
    : ((Number(improvedMetrics.passRate) || 0) - (Number(baselineMetrics.passRate) || 0));
  const avgScoreDelta = Number.isFinite(delta.avgScore)
    ? delta.avgScore
    : ((Number(improvedMetrics.avgScore) || 0) - (Number(baselineMetrics.avgScore) || 0));
  const baselineErrorRate = Number(baselineMetrics.errorRate) || 0;
  const improvedErrorRate = Number(improvedMetrics.errorRate) || 0;
  const improvedDurationP95Ms = Number(improvedMetrics.durationP95Ms) || 0;
  const improvedTimeoutRate = Number(improvedMetrics.timeoutOrDeadlineErrorRate) || 0;
  const improvedPartialRate = Number(improvedMetrics.partialRate) || 0;
  const improvedDeepCoverageRate = Number(improvedMetrics.deepCoverageRate) || 0;
  const improvedDeepCoverageSamples = Number(improvedMetrics.omittedCoverageSampleCount) || 0;
  const improvedHighRiskIssueCoverageRate = Number(improvedMetrics.highRiskIssueCoverageRate) || 0;
  const improvedHighRiskFixtureCount = Number(improvedMetrics.highRiskFixtureCount) || 0;
  const improvedFirstSignalDataRate = Number(improvedMetrics.firstSignalDataRate) || 0;
  const improvedFirstSignalP95Ms = Number(improvedMetrics.firstSignalP95Ms) || 0;
  const improvedFirstSignalSampleCount = Number(improvedMetrics.firstSignalSampleCount) || 0;
  const improvedChunkCadence = Number(improvedMetrics.chunkCadencePerMinute) || 0;
  const improvedChunkCadenceSampleCount = Number(improvedMetrics.chunkCadenceSampleCount) || 0;
  const improvedMediumVerifierCoverageRate = Number(improvedMetrics.mediumVerifierCoverageRate) || 0;
  const improvedMediumVerifierSampleCount = Number(improvedMetrics.mediumVerifierSampleCount) || 0;
  const improvedUnsupportedIssueRate = Number(improvedMetrics.unsupportedIssueRate) || 0;
  const improvedUnsupportedIssueSampleCount = Number(improvedMetrics.unsupportedIssueSampleCount) || 0;
  const improvedLowEvidenceIssueRate = Number(improvedMetrics.lowEvidenceIssueRate) || 0;
  const improvedLowEvidenceIssueSampleCount = Number(improvedMetrics.lowEvidenceIssueSampleCount) || 0;
  const improvedDismissedIssueRate = Number(improvedMetrics.dismissedIssueRate) || 0;
  const improvedDismissedIssueSampleCount = Number(improvedMetrics.dismissedIssueSampleCount) || 0;
  const improvedUncorroboratedHighRiskRate = Number(improvedMetrics.uncorroboratedHighRiskRate) || 0;
  const improvedUncorroboratedHighRiskSampleCount = Number(improvedMetrics.uncorroboratedHighRiskSampleCount) || 0;
  const improvedOutcomeSuppressionRate = Number(improvedMetrics.outcomeSuppressionRate) || 0;
  const improvedOutcomeSuppressionSampleCount = Number(improvedMetrics.outcomeSuppressionSampleCount) || 0;
  const hasCompletedFixtures = completedFixtures > 0;
  const missingDeepCoverageTelemetry = hasCompletedFixtures && improvedDeepCoverageSamples === 0;
  const missingFirstSignalTelemetry = hasCompletedFixtures && improvedFirstSignalSampleCount === 0;
  const missingChunkCadenceTelemetry = hasCompletedFixtures && improvedChunkCadenceSampleCount === 0;
  const mediumVerifierCoverageThreshold = Math.max(0, Math.min(1, Number(thresholds.minMediumVerifierCoverageRate) || 0));
  const missingMediumVerifierTelemetry = (
    hasCompletedFixtures
    && mediumVerifierCoverageThreshold > 0
    && improvedMediumVerifierSampleCount === 0
  );
  const missingUnsupportedIssueTelemetry = hasCompletedFixtures && improvedUnsupportedIssueSampleCount === 0;
  const missingLowEvidenceIssueTelemetry = hasCompletedFixtures && improvedLowEvidenceIssueSampleCount === 0;
  const missingDismissedIssueTelemetry = hasCompletedFixtures && improvedDismissedIssueSampleCount === 0;
  const missingUncorroboratedHighRiskTelemetry = hasCompletedFixtures && improvedUncorroboratedHighRiskSampleCount === 0;
  const missingOutcomeSuppressionTelemetry = hasCompletedFixtures && improvedOutcomeSuppressionSampleCount === 0;

  const checks = [
    {
      id: 'fixtures',
      label: `completed fixtures >= ${thresholds.minCompletedFixtures}`,
      pass: completedFixtures >= thresholds.minCompletedFixtures,
      detail: `${completedFixtures}/${thresholds.minCompletedFixtures}`,
      severity: 'critical',
      reasonCode: 'gate_insufficient_fixtures',
    },
    {
      id: 'pass_rate_delta',
      label: `pass-rate delta >= ${formatRate(thresholds.minPassRateDelta)}`,
      pass: passRateDelta >= thresholds.minPassRateDelta,
      detail: `${formatRate(passRateDelta)} (${formatRate(baselineMetrics.passRate || 0)} -> ${formatRate(improvedMetrics.passRate || 0)})`,
      severity: 'warning',
      reasonCode: 'gate_pass_rate_delta_low',
    },
    {
      id: 'avg_score_delta',
      label: `avg-score delta >= ${(thresholds.minAvgScoreDelta * 100).toFixed(1)} pts`,
      pass: avgScoreDelta >= thresholds.minAvgScoreDelta,
      detail: `${(avgScoreDelta * 100).toFixed(1)} pts (${((baselineMetrics.avgScore || 0) * 100).toFixed(1)} -> ${((improvedMetrics.avgScore || 0) * 100).toFixed(1)})`,
      severity: 'warning',
      reasonCode: 'gate_avg_score_delta_low',
    },
    {
      id: 'error_regression',
      label: `error-rate regression <= ${formatRate(thresholds.maxErrorRateRegression)}`,
      pass: improvedErrorRate <= (baselineErrorRate + thresholds.maxErrorRateRegression),
      detail: `${formatRate(improvedErrorRate - baselineErrorRate)} (${formatRate(baselineErrorRate)} -> ${formatRate(improvedErrorRate)})`,
      severity: 'critical',
      reasonCode: 'gate_error_regression_exceeded',
    },
    {
      id: 'duration_p95',
      label: `duration p95 <= ${Math.round(thresholds.maxDurationP95Ms)}ms`,
      pass: improvedDurationP95Ms <= thresholds.maxDurationP95Ms,
      detail: `${Math.round(improvedDurationP95Ms)}ms`,
      severity: 'critical',
      reasonCode: 'gate_duration_p95_exceeded',
    },
    {
      id: 'timeout_rate',
      label: `timeout/deadline error rate <= ${formatRate(thresholds.maxTimeoutOrDeadlineErrorRate)}`,
      pass: improvedTimeoutRate <= thresholds.maxTimeoutOrDeadlineErrorRate,
      detail: `${formatRate(improvedTimeoutRate)}`,
      severity: 'critical',
      reasonCode: 'gate_timeout_rate_exceeded',
    },
    {
      id: 'partial_rate',
      label: `partial review rate <= ${formatRate(thresholds.maxPartialRate)}`,
      pass: improvedPartialRate <= thresholds.maxPartialRate,
      detail: `${formatRate(improvedPartialRate)}`,
      severity: 'critical',
      reasonCode: 'gate_partial_rate_exceeded',
    },
    {
      id: 'deep_coverage',
      label: `deep coverage rate >= ${formatRate(thresholds.minDeepCoverageRate)}`,
      pass: !missingDeepCoverageTelemetry && improvedDeepCoverageRate >= thresholds.minDeepCoverageRate,
      detail: missingDeepCoverageTelemetry
        ? 'missing telemetry (no deep-coverage samples)'
        : `${formatRate(improvedDeepCoverageRate)}`,
      severity: 'critical',
      reasonCode: missingDeepCoverageTelemetry
        ? 'gate_telemetry_missing_deep_coverage'
        : 'gate_deep_coverage_below_floor',
    },
    {
      id: 'high_risk_issue_coverage',
      label: `high-risk issue coverage >= ${formatRate(thresholds.minHighRiskIssueCoverageRate)}`,
      pass: improvedHighRiskFixtureCount === 0 || improvedHighRiskIssueCoverageRate >= thresholds.minHighRiskIssueCoverageRate,
      detail: improvedHighRiskFixtureCount === 0
        ? 'n/a (no high-risk fixtures)'
        : `${formatRate(improvedHighRiskIssueCoverageRate)}`,
      severity: 'critical',
      reasonCode: 'gate_high_risk_issue_coverage_below_floor',
    },
    {
      id: 'first_signal_data_rate',
      label: `first-signal data rate >= ${formatRate(thresholds.minFirstSignalDataRate)}`,
      pass: !missingFirstSignalTelemetry && improvedFirstSignalDataRate >= thresholds.minFirstSignalDataRate,
      detail: missingFirstSignalTelemetry
        ? 'missing telemetry (no first-signal samples)'
        : `${formatRate(improvedFirstSignalDataRate)}`,
      severity: missingFirstSignalTelemetry ? 'critical' : 'warning',
      reasonCode: missingFirstSignalTelemetry
        ? 'gate_telemetry_missing_first_signal'
        : 'gate_first_signal_data_low',
    },
    {
      id: 'first_signal_p95',
      label: `first-signal latency p95 <= ${Math.round(thresholds.maxFirstSignalP95Ms)}ms`,
      pass: !missingFirstSignalTelemetry && improvedFirstSignalP95Ms <= thresholds.maxFirstSignalP95Ms,
      detail: missingFirstSignalTelemetry
        ? 'missing telemetry (no first-signal samples)'
        : `${Math.round(improvedFirstSignalP95Ms)}ms`,
      severity: missingFirstSignalTelemetry ? 'critical' : 'warning',
      reasonCode: missingFirstSignalTelemetry
        ? 'gate_telemetry_missing_first_signal'
        : 'gate_first_signal_latency_high',
    },
    {
      id: 'chunk_cadence',
      label: `chunk cadence >= ${Number(thresholds.minChunkCadencePerMinute).toFixed(2)} chunks/min`,
      pass: !missingChunkCadenceTelemetry && improvedChunkCadence >= thresholds.minChunkCadencePerMinute,
      detail: missingChunkCadenceTelemetry
        ? 'missing telemetry (no chunk cadence samples)'
        : `${improvedChunkCadence.toFixed(2)} chunks/min`,
      severity: missingChunkCadenceTelemetry ? 'critical' : 'warning',
      reasonCode: missingChunkCadenceTelemetry
        ? 'gate_telemetry_missing_chunk_cadence'
        : 'gate_chunk_cadence_low',
    },
    {
      id: 'medium_verifier_coverage',
      label: `medium verifier coverage >= ${formatRate(mediumVerifierCoverageThreshold)}`,
      pass: mediumVerifierCoverageThreshold <= 0
        || (
          !missingMediumVerifierTelemetry
          && improvedMediumVerifierCoverageRate >= mediumVerifierCoverageThreshold
        ),
      detail: mediumVerifierCoverageThreshold <= 0
        ? 'disabled'
        : missingMediumVerifierTelemetry
          ? 'missing telemetry (no medium-verifier samples)'
          : `${formatRate(improvedMediumVerifierCoverageRate)}`,
      severity: missingMediumVerifierTelemetry ? 'critical' : 'warning',
      reasonCode: missingMediumVerifierTelemetry
        ? 'gate_telemetry_missing_medium_verifier'
        : 'gate_medium_verifier_coverage_low',
    },
    {
      id: 'precision_unsupported_issue_rate',
      label: `unsupported issue rate <= ${formatRate(thresholds.maxUnsupportedIssueRate)}`,
      pass: missingUnsupportedIssueTelemetry || improvedUnsupportedIssueRate <= thresholds.maxUnsupportedIssueRate,
      detail: missingUnsupportedIssueTelemetry
        ? 'n/a (no verifier precision samples)'
        : `${formatRate(improvedUnsupportedIssueRate)}`,
      severity: 'critical',
      reasonCode: 'gate_precision_unsupported_issue_rate_high',
    },
    {
      id: 'precision_low_evidence_issue_rate',
      label: `low-evidence issue rate <= ${formatRate(thresholds.maxLowEvidenceIssueRate)}`,
      pass: missingLowEvidenceIssueTelemetry || improvedLowEvidenceIssueRate <= thresholds.maxLowEvidenceIssueRate,
      detail: missingLowEvidenceIssueTelemetry
        ? 'n/a (no precision issue samples)'
        : `${formatRate(improvedLowEvidenceIssueRate)}`,
      severity: 'critical',
      reasonCode: 'gate_precision_low_evidence_issue_rate_high',
    },
    {
      id: 'precision_dismissed_issue_rate',
      label: `dismissed issue rate <= ${formatRate(thresholds.maxDismissedIssueRate)}`,
      pass: missingDismissedIssueTelemetry || improvedDismissedIssueRate <= thresholds.maxDismissedIssueRate,
      detail: missingDismissedIssueTelemetry
        ? 'n/a (no dismissal telemetry samples)'
        : `${formatRate(improvedDismissedIssueRate)}`,
      severity: 'warning',
      reasonCode: 'gate_precision_dismissed_issue_rate_high',
    },
    {
      id: 'precision_uncorroborated_high_risk_rate',
      label: `uncorroborated high-risk rate <= ${formatRate(thresholds.maxUncorroboratedHighRiskRate)}`,
      pass: missingUncorroboratedHighRiskTelemetry || improvedUncorroboratedHighRiskRate <= thresholds.maxUncorroboratedHighRiskRate,
      detail: missingUncorroboratedHighRiskTelemetry
        ? 'n/a (no corroboration telemetry samples)'
        : `${formatRate(improvedUncorroboratedHighRiskRate)}`,
      severity: 'critical',
      reasonCode: 'gate_precision_uncorroborated_high_risk_rate_high',
    },
    {
      id: 'precision_outcome_suppression_rate',
      label: `outcome suppression rate <= ${formatRate(thresholds.maxOutcomeSuppressionRate)}`,
      pass: missingOutcomeSuppressionTelemetry || improvedOutcomeSuppressionRate <= thresholds.maxOutcomeSuppressionRate,
      detail: missingOutcomeSuppressionTelemetry
        ? 'n/a (no suppression telemetry samples)'
        : `${formatRate(improvedOutcomeSuppressionRate)}`,
      severity: 'warning',
      reasonCode: 'gate_precision_outcome_suppression_rate_high',
    },
  ];

  const failedCritical = checks.filter((check) => !check.pass && check.severity === 'critical');
  const failedWarning = checks.filter((check) => !check.pass && check.severity === 'warning');
  const status = failedCritical.length > 0
    ? 'fail'
    : failedWarning.length > 0
      ? 'warn'
      : 'pass';
  const passed = status === 'pass';
  const reasonCodes = Array.from(new Set(
    checks
      .filter((check) => !check.pass)
      .map((check) => check.reasonCode || `gate_${check.id}_failed`)
  ));

  return {
    passed,
    status,
    recommendation: status === 'pass'
      ? 'promote_default'
      : status === 'warn'
        ? 'hold_canary'
        : 'keep_canary',
    thresholds,
    checks,
    reasonCodes,
  };
}

function countIssueRecommendations(recommendations = []) {
  return recommendations.filter((recommendation) => recommendation?.type === 'issue').length;
}

function countHighSeverityIssueRecommendations(recommendations = []) {
  return recommendations.filter((recommendation) => (
    recommendation?.type === 'issue'
    && ['high', 'critical'].includes(String(recommendation?.severity || '').trim().toLowerCase())
  )).length;
}

function summarizeReviewFindingCounts(review = null) {
  if (!review || typeof review !== 'object') {
    return {
      issueCount: null,
      highSeverityIssueCount: null,
      commentEligibleIssueCount: null,
      withheldFindings: null,
      candidateFindingCount: null,
      promotedCandidateCount: null,
      remainingCandidateCount: null,
      supportedCandidateCount: null,
    };
  }

  const recommendations = Array.isArray(review.recommendations) ? review.recommendations : [];
  const candidateFindings = Array.isArray(review.candidateFindings) ? review.candidateFindings : [];
  const issueCount = Number.isFinite(Number(review.issueCount))
    ? Number(review.issueCount)
    : countIssueRecommendations(recommendations);
  const highSeverityIssueCount = Number.isFinite(Number(review.highSeverityIssueCount))
    ? Number(review.highSeverityIssueCount)
    : countHighSeverityIssueRecommendations(recommendations);
  const commentEligibleIssueCount = Number.isFinite(Number(review.commentEligibleIssueCount))
    ? Number(review.commentEligibleIssueCount)
    : recommendations.filter((recommendation) => (
      recommendation?.type === 'issue'
      && recommendation?.commentEligible === true
    )).length;
  const withheldFindings = Number.isFinite(Number(review.withheldFindings))
    ? Number(review.withheldFindings)
    : Math.max(0, issueCount - commentEligibleIssueCount);
  const candidateFindingCount = Number.isFinite(Number(review.candidateFindingCount))
    ? Number(review.candidateFindingCount)
    : candidateFindings.length;
  const promotedCandidateCount = Number.isFinite(Number(review.promotedCandidateCount))
    ? Number(review.promotedCandidateCount)
    : candidateFindings.filter((candidate) => candidate?.promotedFromCandidate === true).length;
  const supportedCandidateCount = Number.isFinite(Number(review.supportedCandidateCount))
    ? Number(review.supportedCandidateCount)
    : candidateFindings.filter((candidate) => String(candidate?.verifierDecision || '').trim().toLowerCase() === 'supported').length;
  const remainingCandidateCount = Number.isFinite(Number(review.remainingCandidateCount))
    ? Number(review.remainingCandidateCount)
    : Math.max(0, candidateFindingCount - promotedCandidateCount);

  return {
    issueCount,
    highSeverityIssueCount,
    commentEligibleIssueCount,
    withheldFindings,
    candidateFindingCount,
    promotedCandidateCount,
    remainingCandidateCount,
    supportedCandidateCount,
  };
}

function toFiniteNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildFixtureSnapshot(result = null) {
  if (!result || typeof result !== 'object') return null;
  const findingCounts = summarizeReviewFindingCounts(result.review);
  const score = toFiniteNumberOrNull(result?.score?.score);
  const checksPassedRatio = (
    Number(result?.score?.total) > 0
    && Number.isFinite(Number(result?.score?.passed))
  )
    ? (Number(result.score.passed) / Number(result.score.total))
    : null;
  return {
    status: typeof result.status === 'string' ? result.status : null,
    pass: result.status === 'pass'
      ? true
      : result.status === 'fail'
        ? false
        : null,
    score,
    checksPassedRatio,
    recommendationCount: toFiniteNumberOrNull(result?.review?.recommendationCount),
    issueCount: findingCounts.issueCount,
    highSeverityIssueCount: findingCounts.highSeverityIssueCount,
    commentEligibleIssueCount: findingCounts.commentEligibleIssueCount,
    withheldFindings: findingCounts.withheldFindings,
    candidateFindingCount: findingCounts.candidateFindingCount,
    promotedCandidateCount: findingCounts.promotedCandidateCount,
    remainingCandidateCount: findingCounts.remainingCandidateCount,
    supportedCandidateCount: findingCounts.supportedCandidateCount,
    riskLevel: result?.review?.riskLevel || null,
    promptLength: toFiniteNumberOrNull(result?.promptLength),
    promptContextUsedChars: toFiniteNumberOrNull(result?.promptContextTelemetry?.usedChars),
    promptContextBudgetChars: toFiniteNumberOrNull(result?.promptContextTelemetry?.budgetChars),
    promptContextTruncated: result?.promptContextTelemetry?.truncated === true,
    durationMs: toFiniteNumberOrNull(result?.durationMs),
  };
}

function deltaNumber(afterValue, beforeValue) {
  if (!Number.isFinite(afterValue) || !Number.isFinite(beforeValue)) return null;
  return afterValue - beforeValue;
}

function classifyDirectionalDelta(delta) {
  if (!Number.isFinite(delta)) return 'n/a';
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'unchanged';
}

function classifyScoreTrend(baseline, improved) {
  if (!baseline || !improved) return 'n/a';
  if (baseline.pass === false && improved.pass === true) return 'improved';
  if (baseline.pass === true && improved.pass === false) return 'regressed';
  const delta = deltaNumber(improved.score, baseline.score);
  if (!Number.isFinite(delta)) return 'n/a';
  if (delta > 0) return 'improved';
  if (delta < 0) return 'regressed';
  return 'unchanged';
}

function classifyPassTrend(baseline, improved) {
  if (!baseline || !improved || baseline.pass == null || improved.pass == null) return 'n/a';
  if (baseline.pass === improved.pass) return 'unchanged';
  return improved.pass ? 'improved' : 'regressed';
}

function classifyTruncationTrend(baseline, improved) {
  if (!baseline || !improved) return 'n/a';
  if (baseline.promptContextTruncated === improved.promptContextTruncated) return 'unchanged';
  return improved.promptContextTruncated ? 'introduced' : 'resolved';
}

function buildFixtureComparisonRows(baselineRun = null, improvedRun = null) {
  const baselineResults = Array.isArray(baselineRun?.results) ? baselineRun.results : [];
  const improvedResults = Array.isArray(improvedRun?.results) ? improvedRun.results : [];
  const improvedMap = new Map(improvedResults.map((result) => [result.id, result]));
  const seen = new Set();
  const rows = [];

  for (const baselineResult of baselineResults) {
    const improvedResult = improvedMap.get(baselineResult.id) || null;
    seen.add(baselineResult.id);
    const baselineSnapshot = buildFixtureSnapshot(baselineResult);
    const improvedSnapshot = buildFixtureSnapshot(improvedResult);
    rows.push({
      id: baselineResult.id,
      label: baselineResult.label,
      surface: baselineResult.surface || improvedResult?.surface || null,
      fixtureSet: baselineResult.fixtureSet || improvedResult?.fixtureSet || null,
      benchmarkDimensions: normalizeBenchmarkDimensions(
        baselineResult.benchmarkDimensions || improvedResult?.benchmarkDimensions
      ),
      baseline: baselineSnapshot,
      improved: improvedSnapshot,
      delta: {
        score: deltaNumber(improvedSnapshot?.score, baselineSnapshot?.score),
        checksPassedRatio: deltaNumber(improvedSnapshot?.checksPassedRatio, baselineSnapshot?.checksPassedRatio),
        recommendationCount: deltaNumber(improvedSnapshot?.recommendationCount, baselineSnapshot?.recommendationCount),
        issueCount: deltaNumber(improvedSnapshot?.issueCount, baselineSnapshot?.issueCount),
        highSeverityIssueCount: deltaNumber(improvedSnapshot?.highSeverityIssueCount, baselineSnapshot?.highSeverityIssueCount),
        commentEligibleIssueCount: deltaNumber(improvedSnapshot?.commentEligibleIssueCount, baselineSnapshot?.commentEligibleIssueCount),
        withheldFindings: deltaNumber(improvedSnapshot?.withheldFindings, baselineSnapshot?.withheldFindings),
        candidateFindingCount: deltaNumber(improvedSnapshot?.candidateFindingCount, baselineSnapshot?.candidateFindingCount),
        promotedCandidateCount: deltaNumber(improvedSnapshot?.promotedCandidateCount, baselineSnapshot?.promotedCandidateCount),
        remainingCandidateCount: deltaNumber(improvedSnapshot?.remainingCandidateCount, baselineSnapshot?.remainingCandidateCount),
        supportedCandidateCount: deltaNumber(improvedSnapshot?.supportedCandidateCount, baselineSnapshot?.supportedCandidateCount),
        promptLength: deltaNumber(improvedSnapshot?.promptLength, baselineSnapshot?.promptLength),
        promptContextUsedChars: deltaNumber(improvedSnapshot?.promptContextUsedChars, baselineSnapshot?.promptContextUsedChars),
        durationMs: deltaNumber(improvedSnapshot?.durationMs, baselineSnapshot?.durationMs),
      },
      outcome: {
        scoreTrend: classifyScoreTrend(baselineSnapshot, improvedSnapshot),
        passTrend: classifyPassTrend(baselineSnapshot, improvedSnapshot),
        promptLengthTrend: classifyDirectionalDelta(deltaNumber(improvedSnapshot?.promptLength, baselineSnapshot?.promptLength)),
        promptContextTrend: classifyDirectionalDelta(deltaNumber(improvedSnapshot?.promptContextUsedChars, baselineSnapshot?.promptContextUsedChars)),
        truncationTrend: classifyTruncationTrend(baselineSnapshot, improvedSnapshot),
      },
    });
  }

  for (const improvedResult of improvedResults) {
    if (seen.has(improvedResult.id)) continue;
    const improvedSnapshot = buildFixtureSnapshot(improvedResult);
    rows.push({
      id: improvedResult.id,
      label: improvedResult.label,
      surface: improvedResult.surface || null,
      fixtureSet: improvedResult.fixtureSet || null,
      benchmarkDimensions: normalizeBenchmarkDimensions(improvedResult.benchmarkDimensions),
      baseline: null,
      improved: improvedSnapshot,
      delta: {
        score: null,
        checksPassedRatio: null,
        recommendationCount: null,
        issueCount: null,
        highSeverityIssueCount: null,
        commentEligibleIssueCount: null,
        withheldFindings: null,
        candidateFindingCount: null,
        promotedCandidateCount: null,
        remainingCandidateCount: null,
        supportedCandidateCount: null,
        promptLength: null,
        promptContextUsedChars: null,
        durationMs: null,
      },
      outcome: {
        scoreTrend: 'n/a',
        passTrend: 'n/a',
        promptLengthTrend: 'n/a',
        promptContextTrend: 'n/a',
        truncationTrend: 'n/a',
      },
    });
  }

  return rows;
}

function summarizeFixtureComparisonRowsByDimension(rows = [], dimensionKey) {
  const normalizedKey = String(dimensionKey || '').trim();
  if (!normalizedKey) return {};

  const groupedRows = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const dimensionValue = String(row?.benchmarkDimensions?.[normalizedKey] || '').trim();
    if (!dimensionValue) continue;
    const existing = groupedRows.get(dimensionValue) || [];
    existing.push(row);
    groupedRows.set(dimensionValue, existing);
  }

  return Object.fromEntries(
    [...groupedRows.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dimensionValue, dimensionRows]) => {
        const summary = summarizeFixtureComparisonRows(dimensionRows);
        return [dimensionValue, {
          ...summary,
          fixtureIds: dimensionRows.map((row) => row.id),
        }];
      })
  );
}

function summarizeFixtureComparisonRows(rows = []) {
  const summary = {
    totalFixtures: Array.isArray(rows) ? rows.length : 0,
    scoreImproved: 0,
    scoreRegressed: 0,
    scoreUnchanged: 0,
    passImproved: 0,
    passRegressed: 0,
    findingCountIncreased: 0,
    findingCountDecreased: 0,
    candidateCountIncreased: 0,
    candidateCountDecreased: 0,
    promotedCandidateCountIncreased: 0,
    promotedCandidateCountDecreased: 0,
    promptCharsIncreased: 0,
    promptCharsDecreased: 0,
    truncationIntroduced: 0,
    truncationResolved: 0,
  };

  for (const row of rows || []) {
    switch (row?.outcome?.scoreTrend) {
      case 'improved':
        summary.scoreImproved += 1;
        break;
      case 'regressed':
        summary.scoreRegressed += 1;
        break;
      case 'unchanged':
        summary.scoreUnchanged += 1;
        break;
      default:
        break;
    }

    if (row?.outcome?.passTrend === 'improved') summary.passImproved += 1;
    if (row?.outcome?.passTrend === 'regressed') summary.passRegressed += 1;

    if (Number.isFinite(row?.delta?.issueCount)) {
      if (row.delta.issueCount > 0) summary.findingCountIncreased += 1;
      if (row.delta.issueCount < 0) summary.findingCountDecreased += 1;
    }

    if (Number.isFinite(row?.delta?.candidateFindingCount)) {
      if (row.delta.candidateFindingCount > 0) summary.candidateCountIncreased += 1;
      if (row.delta.candidateFindingCount < 0) summary.candidateCountDecreased += 1;
    }

    if (Number.isFinite(row?.delta?.promotedCandidateCount)) {
      if (row.delta.promotedCandidateCount > 0) summary.promotedCandidateCountIncreased += 1;
      if (row.delta.promotedCandidateCount < 0) summary.promotedCandidateCountDecreased += 1;
    }

    if (Number.isFinite(row?.delta?.promptLength)) {
      if (row.delta.promptLength > 0) summary.promptCharsIncreased += 1;
      if (row.delta.promptLength < 0) summary.promptCharsDecreased += 1;
    }

    if (row?.outcome?.truncationTrend === 'introduced') summary.truncationIntroduced += 1;
    if (row?.outcome?.truncationTrend === 'resolved') summary.truncationResolved += 1;
  }

  return summary;
}

function buildHarnessComparison({
  baselineRun,
  improvedRun,
  baselineLabel = 'baseline',
  improvedLabel = 'candidate',
  adaptiveThresholds = null,
  gateThresholds = null,
  tuningTargets = null,
} = {}) {
  const normalizedAdaptiveThresholds = normalizeAdaptiveThresholds(adaptiveThresholds);
  const baselineMetrics = summarizeHarnessMetrics(baselineRun?.results || [], normalizedAdaptiveThresholds);
  const improvedMetrics = summarizeHarnessMetrics(improvedRun?.results || [], normalizedAdaptiveThresholds);
  const fixtureComparison = buildFixtureComparisonRows(baselineRun, improvedRun);

  const comparison = {
    baseline: {
      mode: baselineLabel,
      ...(baselineRun || {}),
      metrics: baselineMetrics,
    },
    improved: {
      mode: improvedLabel,
      ...(improvedRun || {}),
      metrics: improvedMetrics,
    },
    delta: {
      passRate: improvedMetrics.passRate - baselineMetrics.passRate,
      avgScore: improvedMetrics.avgScore - baselineMetrics.avgScore,
      avgRecommendations: improvedMetrics.avgRecommendations - baselineMetrics.avgRecommendations,
      avgChecksPassedRatio: improvedMetrics.avgChecksPassedRatio - baselineMetrics.avgChecksPassedRatio,
      avgPromptChars: improvedMetrics.avgPromptChars - baselineMetrics.avgPromptChars,
      avgPromptContextUsedChars: improvedMetrics.avgPromptContextUsedChars - baselineMetrics.avgPromptContextUsedChars,
      promptContextTruncatedRate: improvedMetrics.promptContextTruncatedRate - baselineMetrics.promptContextTruncatedRate,
      localVerificationCoverageRate: improvedMetrics.localVerificationCoverageRate - baselineMetrics.localVerificationCoverageRate,
      localVerificationSuppressionRate: improvedMetrics.localVerificationSuppressionRate - baselineMetrics.localVerificationSuppressionRate,
      localVerificationProductionPathRate: improvedMetrics.localVerificationProductionPathRate - baselineMetrics.localVerificationProductionPathRate,
    },
    fixtureComparison,
    fixtureComparisonSummary: summarizeFixtureComparisonRows(fixtureComparison),
    fixtureComparisonDimensions: {
      bugClass: summarizeFixtureComparisonRowsByDimension(fixtureComparison, 'bugClass'),
      stack: summarizeFixtureComparisonRowsByDimension(fixtureComparison, 'stack'),
      evaluationFocus: summarizeFixtureComparisonRowsByDimension(fixtureComparison, 'evaluationFocus'),
    },
  };

  return {
    ...comparison,
    rolloutGate: evaluateRolloutGate(comparison, gateThresholds),
    tuningSignals: buildTuningSignals(comparison, normalizedAdaptiveThresholds, tuningTargets),
  };
}

async function compareQualityModes(options = {}) {
  const {
    fixtureIds,
    fixtureSet = null,
    surface = null,
    dryRun = false,
    gateThresholds = null,
    adaptiveConfig = null,
    tuningTargets = null,
    preferredProviderId = null,
  } = options;
  const baseline = await runHarness({ fixtureIds, fixtureSet, surface, dryRun, qualityMode: 'v1', preferredProviderId });
  const improved = await runHarness({ fixtureIds, fixtureSet, surface, dryRun, qualityMode: 'v2', preferredProviderId });

  return buildHarnessComparison({
    baselineRun: baseline,
    improvedRun: improved,
    baselineLabel: 'v1',
    improvedLabel: 'v2',
    adaptiveThresholds: adaptiveConfig,
    gateThresholds,
    tuningTargets,
  });
}

async function compareBenchmarkVariants(options = {}) {
  const {
    fixtureIds,
    fixtureSet = null,
    surface = null,
    dryRun = false,
    gateThresholds = null,
    adaptiveConfig = null,
    tuningTargets = null,
    baseline = {},
    candidate = {},
    pipelineFeatures = null,
    preferredProviderId = null,
  } = options;

  const baselineRun = await runHarness({
    fixtureIds,
    fixtureSet,
    surface,
    dryRun,
    qualityMode: baseline?.qualityMode || 'auto',
    promptMetadataOverrides: baseline?.promptMetadataOverrides || null,
    reviewModelStrategy: baseline?.reviewModelStrategy || null,
    reviewModelAdaptive: baseline?.reviewModelAdaptive || adaptiveConfig,
    reviewModelRollout: baseline?.reviewModelRollout || null,
    reviewModelCustom: baseline?.reviewModelCustom || null,
    prReviewMode: baseline?.prReviewMode || null,
    pipelineFeatures: baseline?.pipelineFeatures || null,
    promptContext: baseline?.promptContext || null,
    preferredProviderId,
  });
  const candidateRun = await runHarness({
    fixtureIds,
    fixtureSet,
    surface,
    dryRun,
    qualityMode: candidate?.qualityMode || 'auto',
    promptMetadataOverrides: candidate?.promptMetadataOverrides || null,
    reviewModelStrategy: candidate?.reviewModelStrategy || null,
    reviewModelAdaptive: candidate?.reviewModelAdaptive || adaptiveConfig,
    reviewModelRollout: candidate?.reviewModelRollout || null,
    reviewModelCustom: candidate?.reviewModelCustom || null,
    prReviewMode: candidate?.prReviewMode || null,
    pipelineFeatures: candidate?.pipelineFeatures || pipelineFeatures || null,
    promptContext: candidate?.promptContext || null,
    preferredProviderId,
  });

  return buildHarnessComparison({
    baselineRun,
    improvedRun: candidateRun,
    baselineLabel: String(baseline?.label || 'control'),
    improvedLabel: String(candidate?.label || 'candidate'),
    adaptiveThresholds: adaptiveConfig,
    gateThresholds,
    tuningTargets,
  });
}

function recommendStrategyFromMatrix(strategies = []) {
  const completed = strategies.filter((entry) => Number(entry?.metrics?.fixtures || 0) > 0);
  if (completed.length === 0) {
    return {
      strategy: null,
      reason: 'no_completed_fixtures',
    };
  }

  let best = completed[0];
  for (const candidate of completed.slice(1)) {
    const candidatePass = Number(candidate?.metrics?.passRate || 0);
    const bestPass = Number(best?.metrics?.passRate || 0);
    if (candidatePass > bestPass + 0.0001) {
      best = candidate;
      continue;
    }

    const candidateScore = Number(candidate?.metrics?.avgScore || 0);
    const bestScore = Number(best?.metrics?.avgScore || 0);
    if (Math.abs(candidatePass - bestPass) <= 0.0001 && candidateScore > bestScore + 0.0001) {
      best = candidate;
      continue;
    }

    const candidateP95 = Number(candidate?.metrics?.durationP95Ms || Number.POSITIVE_INFINITY);
    const bestP95 = Number(best?.metrics?.durationP95Ms || Number.POSITIVE_INFINITY);
    const comparableQuality = candidatePass >= (bestPass - 0.03) && candidateScore >= (bestScore - 0.03);
    if (comparableQuality && candidateP95 < bestP95 - 1) {
      best = candidate;
    }
  }

  return {
    strategy: best.strategy,
    reason: 'best_quality_with_latency_tiebreak',
    metrics: {
      passRate: Number(best?.metrics?.passRate || 0),
      avgScore: Number(best?.metrics?.avgScore || 0),
      durationP95Ms: Number(best?.metrics?.durationP95Ms || 0),
    },
  };
}

async function compareRoutingStrategies(options = {}) {
  const {
    fixtureIds,
    fixtureSet = null,
    surface = null,
    dryRun = false,
    qualityMode = 'v2',
    adaptiveConfig = null,
    rolloutConfig = null,
    customModels = null,
    strategies = DEFAULT_STRATEGY_MATRIX,
    preferredProviderId = null,
  } = options;

  const normalizedStrategies = Array.isArray(strategies)
    ? strategies
      .map((value) => normalizeStrategyValue(value))
      .filter(Boolean)
    : [...DEFAULT_STRATEGY_MATRIX];
  if (normalizedStrategies.length === 0) {
    return {
      qualityMode,
      strategies: [],
      recommendation: {
        strategy: null,
        reason: 'strategy_matrix_disabled',
      },
    };
  }

  const strategyResults = [];
  for (const strategy of normalizedStrategies) {
    const run = await runHarness({
      fixtureIds,
      fixtureSet,
      surface,
      dryRun,
      qualityMode,
      reviewModelStrategy: strategy,
      reviewModelAdaptive: adaptiveConfig,
      reviewModelRollout: rolloutConfig,
      reviewModelCustom: customModels,
      preferredProviderId,
    });
    strategyResults.push({
      strategy,
      summary: run.summary,
      metrics: summarizeHarnessMetrics(run.results || [], adaptiveConfig),
      run,
    });
  }

  return {
    qualityMode,
    strategies: strategyResults.map(({ strategy, summary, metrics }) => ({
      strategy,
      summary,
      metrics,
    })),
    recommendation: recommendStrategyFromMatrix(strategyResults),
  };
}

/**
 * Get the list of available fixtures (no AI call).
 */
function listFixtures(options = {}) {
  const fixtures = resolveFixtures({
    fixtureIds: options.fixtureIds || null,
    fixtureSet: options.fixtureSet || null,
    surface: options.surface || null,
  });
  return fixtures.map((fixture) => {
    const { context, scenario } = buildFixtureContext(fixture);
    return {
      id: fixture.id,
      label: fixture.label,
      surface: fixture.surface,
      fixtureSet: fixture.fixtureSet,
      benchmarkDimensions: fixture.benchmarkDimensions,
      golden: fixture.golden,
      scenario,
      context,
    };
  });
}

export default {
  runHarness,
  compareQualityModes,
  compareBenchmarkVariants,
  compareRoutingStrategies,
  summarizeHarnessMetrics,
  evaluateRolloutGate,
  listFixtures,
  scoreFixture,
  FIXTURES,
};
