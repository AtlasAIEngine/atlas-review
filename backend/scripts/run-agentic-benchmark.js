#!/usr/bin/env node

/**
 * CLI-Agentic Review Benchmark Script
 *
 * Runs the agentic review mode against test branches and compares
 * results against ground truth and success gates.
 *
 * Usage:
 *   node backend/scripts/run-agentic-benchmark.js
 *
 * Prerequisites:
 *   - Claude CLI installed and authenticated (`claude --version`)
 *   - Running from the AtlasEngineMVP repository root
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const MAX_BENCH_TIMEOUT_MS = 300_000; // 5 minutes per run

const TEST_BRANCHES = [
  {
    id: 'small',
    label: 'Small/Clean (Simplify review panel)',
    commitSha: '55225bc2',
    parentSha: '55225bc2^',
    expectedFileCount: 31,
    groundTruth: {
      minRiskLevel: 'low',
      maxRiskLevel: 'high',
      mustMentionKeywords: ['review', 'panel', 'navigation'],
      minFindings: 0,
      maxFindings: 12,
      mustNotContainPaths: ['nonexistent/file.ts'],
    },
  },
  {
    id: 'medium',
    label: 'Medium (Review reliability + UI state)',
    commitSha: '98f9385f',
    parentSha: '98f9385f^',
    expectedFileCount: 29,
    groundTruth: {
      minRiskLevel: 'low',
      maxRiskLevel: 'high',
      mustMentionKeywords: ['review', 'reliability'],
      minFindings: 0,
      maxFindings: 15,
      mustNotContainPaths: ['nonexistent/file.ts'],
    },
  },
  {
    id: 'large',
    label: 'Large/Cross-file (Decomposition + quality + syntax)',
    commitSha: '9fabcdb0',
    parentSha: '9fabcdb0^',
    expectedFileCount: 67,
    groundTruth: {
      minRiskLevel: 'medium',
      maxRiskLevel: 'critical',
      mustMentionKeywords: ['review'],
      minFindings: 1,
      maxFindings: 30,
      mustNotContainPaths: ['nonexistent/file.ts'],
    },
  },
];

const SUCCESS_GATES = {
  jsonParseRate: 0.95,         // >= 95% successful parses
  maxHallucinatedPaths: 0,     // zero hallucinated file paths
  p50TargetMs: 120_000,        // p50 < 120s (agentic exploration takes longer)
  p95TargetMs: 300_000,        // p95 < 300s (large branches need more tool calls)
  overheadTargetMs: 5_000,     // orchestration overhead < 5s
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function logSection(title) {
  log(`\n${'='.repeat(60)}`);
  log(`  ${title}`);
  log('='.repeat(60));
}

function logResult(label, value, pass = null) {
  const status = pass === null ? '  ' : (pass ? 'PASS' : 'FAIL');
  const statusColor = pass === null ? '' : (pass ? '\x1b[32m' : '\x1b[31m');
  const reset = pass === null ? '' : '\x1b[0m';
  log(`  ${statusColor}[${status}]${reset} ${label}: ${value}`);
}

async function getChangedFilePaths(baseSha, headSha) {
  try {
    const { stdout } = await execFileAsync('git', [
      'diff', '--name-only', `${baseSha}...${headSha}`,
    ], { cwd: REPO_ROOT, timeout: 10_000 });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function fileExistsInRepo(filePath, ref = 'HEAD') {
  try {
    await execFileAsync('git', ['cat-file', '-e', `${ref}:${filePath}`], {
      cwd: REPO_ROOT,
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

function tryParseJson(text) {
  // Try to extract JSON from text that might have markdown fences
  let cleaned = text.trim();

  // Remove markdown fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Find first { ... last }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return { parsed: JSON.parse(cleaned), success: true };
  } catch (e) {
    return { parsed: null, success: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Raw CLI baseline run
// ---------------------------------------------------------------------------

function buildCleanEnv() {
  const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...rest } = process.env;
  return { ...rest, NO_COLOR: '1' };
}

async function runRawCliReview(baseSha, headSha) {
  const prompt = `Review the changes between commits ${baseSha} and ${headSha} in this repository. Run git diff to see changes, read files for context, and return a JSON object with keys: summary, riskLevel, recommendations (array of {type, severity, title, description, file, line}), stats.`;

  const startMs = Date.now();
  return new Promise((resolve) => {
    const child = spawn('claude', [
      '--print',
      '-p', prompt,
      '--max-turns', '25',
      '--dangerously-skip-permissions',
    ], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildCleanEnv(),
    });

    let out = '';
    let err = '';
    let settled = false;

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({
        wallClockMs: Date.now() - startMs,
        rawOutput: out,
        jsonParsed: false,
        review: null,
        error: `Timed out after ${MAX_BENCH_TIMEOUT_MS / 1000}s`,
      });
    }, MAX_BENCH_TIMEOUT_MS);
    if (typeof timer?.unref === 'function') timer.unref();

    child.stdin.end();

    child.on('close', (code) => {
      const wallClockMs = Date.now() - startMs;
      if (code !== 0 && !out.trim()) {
        finish({
          wallClockMs,
          rawOutput: out,
          jsonParsed: false,
          review: null,
          error: err.slice(-500).trim() || `Exit code ${code}`,
        });
        return;
      }
      const { parsed, success } = tryParseJson(out);
      finish({
        wallClockMs,
        rawOutput: out,
        jsonParsed: success,
        review: parsed,
        error: success ? null : 'JSON parse failed',
      });
    });

    child.on('error', (error) => {
      finish({
        wallClockMs: Date.now() - startMs,
        rawOutput: '',
        jsonParsed: false,
        review: null,
        error: error.message,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

async function evaluateReview(review, groundTruth, changedFiles, commitSha) {
  const result = {
    findingCount: 0,
    hallucinatedPaths: [],
    riskLevel: null,
    jsonParsed: review !== null,
    gateResults: {},
  };

  if (!review) return result;

  result.riskLevel = review.riskLevel || null;
  const recommendations = Array.isArray(review.recommendations) ? review.recommendations : [];
  result.findingCount = recommendations.length;

  // Check for hallucinated file paths
  const mentionedPaths = new Set();
  for (const rec of recommendations) {
    if (typeof rec.file === 'string' && rec.file.trim()) {
      mentionedPaths.add(rec.file.trim());
    }
  }
  // Also check changeGroups
  if (Array.isArray(review.changeGroups)) {
    for (const group of review.changeGroups) {
      if (Array.isArray(group.files)) {
        for (const f of group.files) {
          if (typeof f.path === 'string' && f.path.trim()) {
            mentionedPaths.add(f.path.trim());
          }
        }
      }
    }
  }

  // changedFiles includes deleted files — a finding referencing a deleted file
  // is legitimate, not hallucinated.
  const changedFileSet = new Set(Array.isArray(changedFiles) ? changedFiles : []);
  for (const filePath of mentionedPaths) {
    if (changedFileSet.has(filePath)) continue;
    const exists = await fileExistsInRepo(filePath, commitSha);
    if (!exists) {
      result.hallucinatedPaths.push(filePath);
    }
  }

  // Check ground truth gates
  const riskOrder = ['low', 'medium', 'high', 'critical'];
  const riskIdx = riskOrder.indexOf(result.riskLevel);
  const minRiskIdx = riskOrder.indexOf(groundTruth.minRiskLevel);
  const maxRiskIdx = riskOrder.indexOf(groundTruth.maxRiskLevel);

  result.gateResults.riskInRange = riskIdx >= minRiskIdx && riskIdx <= maxRiskIdx;
  result.gateResults.findingCountInRange =
    result.findingCount >= groundTruth.minFindings &&
    result.findingCount <= groundTruth.maxFindings;
  result.gateResults.noHallucinatedPaths = result.hallucinatedPaths.length === 0;

  // Check keyword recall
  const reviewText = JSON.stringify(review).toLowerCase();
  const matchedKeywords = groundTruth.mustMentionKeywords.filter(
    (kw) => reviewText.includes(kw.toLowerCase())
  );
  result.gateResults.keywordRecall = matchedKeywords.length / Math.max(1, groundTruth.mustMentionKeywords.length);

  return result;
}

// ---------------------------------------------------------------------------
// Main benchmark
// ---------------------------------------------------------------------------

async function main() {
  logSection('CLI-Agentic Review Benchmark');
  log(`  Repository: ${REPO_ROOT}`);
  log(`  Test branches: ${TEST_BRANCHES.length}`);
  log(`  Started at: ${new Date().toISOString()}`);

  // Verify Claude CLI is available
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 10_000 });
    log(`  Claude CLI: ${stdout.trim()}`);
  } catch {
    log('\n  ERROR: Claude CLI not found. Install Claude Code CLI and run `claude login`.');
    process.exit(1);
  }

  const allResults = [];
  let totalJsonParseSuccess = 0;
  let totalRuns = 0;

  for (const branch of TEST_BRANCHES) {
    logSection(`Branch: ${branch.label}`);
    log(`  Commit: ${branch.commitSha}`);
    log(`  Expected files: ${branch.expectedFileCount}`);

    const changedFiles = await getChangedFilePaths(branch.parentSha, branch.commitSha);
    log(`  Actual changed files: ${changedFiles.length}`);

    // Run raw CLI baseline
    log('\n  --- Raw CLI Baseline ---');
    const rawResult = await runRawCliReview(branch.parentSha, branch.commitSha);
    logResult('Wall clock', `${rawResult.wallClockMs}ms`);
    logResult('JSON parsed', rawResult.jsonParsed ? 'yes' : 'no', rawResult.jsonParsed);
    if (rawResult.error) logResult('Error', rawResult.error, false);

    totalRuns += 1;
    if (rawResult.jsonParsed) totalJsonParseSuccess += 1;

    const evaluation = await evaluateReview(
      rawResult.review,
      branch.groundTruth,
      changedFiles,
      branch.commitSha
    );
    logResult('Risk level', evaluation.riskLevel || 'N/A');
    logResult('Findings', evaluation.findingCount);
    logResult('Hallucinated paths', evaluation.hallucinatedPaths.length, evaluation.gateResults.noHallucinatedPaths);
    logResult('Keyword recall', `${(evaluation.gateResults.keywordRecall * 100).toFixed(0)}%`, evaluation.gateResults.keywordRecall >= 0.9);
    logResult('Risk in expected range', evaluation.gateResults.riskInRange ? 'yes' : 'no', evaluation.gateResults.riskInRange);
    logResult('Finding count in range', evaluation.gateResults.findingCountInRange ? 'yes' : 'no', evaluation.gateResults.findingCountInRange);

    allResults.push({
      branch: branch.id,
      label: branch.label,
      raw: rawResult,
      evaluation,
    });
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  logSection('Summary');

  const jsonParseRate = totalRuns > 0 ? totalJsonParseSuccess / totalRuns : 0;
  const totalHallucinated = allResults.reduce(
    (sum, r) => sum + r.evaluation.hallucinatedPaths.length, 0
  );
  const timings = allResults
    .filter((r) => r.raw.wallClockMs > 0)
    .map((r) => r.raw.wallClockMs)
    .sort((a, b) => a - b);

  const p50 = timings.length > 0 ? timings[Math.floor(timings.length * 0.5)] : 0;
  const p95 = timings.length > 0 ? timings[Math.floor(timings.length * 0.95)] : 0;

  logResult('JSON parse rate', `${(jsonParseRate * 100).toFixed(0)}%`, jsonParseRate >= SUCCESS_GATES.jsonParseRate);
  logResult('Total hallucinated paths', totalHallucinated, totalHallucinated <= SUCCESS_GATES.maxHallucinatedPaths);
  logResult('p50 latency', `${p50}ms`, p50 <= SUCCESS_GATES.p50TargetMs);
  logResult('p95 latency', `${p95}ms`, p95 <= SUCCESS_GATES.p95TargetMs);

  // Overall verdict
  const allPassed =
    jsonParseRate >= SUCCESS_GATES.jsonParseRate &&
    totalHallucinated <= SUCCESS_GATES.maxHallucinatedPaths &&
    allResults.every((r) => r.evaluation.gateResults.noHallucinatedPaths);

  log('');
  if (allPassed) {
    log('  \x1b[32m>>> OVERALL: PASS <<<\x1b[0m');
  } else {
    log('  \x1b[31m>>> OVERALL: FAIL <<<\x1b[0m');
  }
  log('');

  // Write results to file for post-hoc analysis
  const outputPath = path.join(REPO_ROOT, '.planning', 'phases', 'v0.43.0-cli-agentic-review', 'benchmark-results.json');
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      results: allResults.map((r) => ({
        branch: r.branch,
        label: r.label,
        wallClockMs: r.raw.wallClockMs,
        jsonParsed: r.raw.jsonParsed,
        error: r.raw.error,
        findingCount: r.evaluation.findingCount,
        riskLevel: r.evaluation.riskLevel,
        hallucinatedPaths: r.evaluation.hallucinatedPaths,
        gateResults: r.evaluation.gateResults,
      })),
      summary: {
        jsonParseRate,
        totalHallucinated,
        p50,
        p95,
        overallPass: allPassed,
      },
    }, null, 2));
    log(`  Results written to: ${outputPath}`);
  } catch (e) {
    log(`  Warning: Could not write results file: ${e.message}`);
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
