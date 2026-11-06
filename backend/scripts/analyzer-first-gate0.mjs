#!/usr/bin/env node
// Gate 0 driver — analyzer-first review plan.
// For each PR in a corpus file, scan the parent state of changed files with
// Semgrep + ast-grep and check whether any rule fires within ±5 lines of a
// removed/added range. Writes per-PR JSON + an aggregate __SUMMARY.md.
//
// Usage:
//   node backend/scripts/analyzer-first-gate0.mjs \
//     --corpus  /Users/.../AtlasEngineBenchmarks/corpus/nextjs-prs.json \
//     --repo    /Users/.../AtlasEngineBenchmarks/next.js \
//     --owner   vercel --name next.js \
//     --semgrep-packs p/javascript,p/typescript,p/react,p/security-audit,p/owasp-top-ten \
//     --astgrep-config /Users/.../AtlasEngineBenchmarks/next.js/sgconfig.yml \
//     --tags    review-caught-issue,security,fp-baseline \
//     --fp-numbers 90506,92231 \
//     --out     backend/.artifacts/analyzer-first-gate0/<run-stamp>/next.js

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);
const TOLERANCE_LINES = 5;
const SEMGREP_TIMEOUT_PER_FILE_S = 30;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    out[k.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

async function gh(args, cwd) {
  const { stdout } = await execFileP('gh', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function git(args, cwd, opts = {}) {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, ...opts });
  return stdout;
}

async function gitOk(args, cwd) {
  try { await git(args, cwd); return true; } catch { return false; }
}

async function ensureSha(repo, sha, prNumber) {
  if (await gitOk(['cat-file', '-e', `${sha}^{commit}`], repo)) return;
  // Fetch the PR head ref — this also brings the base if the PR branched recently.
  try {
    await git(['fetch', '--quiet', '--no-tags', 'origin', `pull/${prNumber}/head`], repo);
  } catch {
    // Some PRs may need explicit SHA fetch.
  }
  if (await gitOk(['cat-file', '-e', `${sha}^{commit}`], repo)) return;
  try {
    await git(['fetch', '--quiet', '--no-tags', 'origin', sha], repo);
  } catch {
    // Last resort — keep going; downstream will report missing SHA.
  }
}

async function getPrShas(owner, name, prNumber, repo) {
  const raw = await gh(
    ['pr', 'view', String(prNumber), '--repo', `${owner}/${name}`, '--json', 'baseRefOid,headRefOid,mergeCommit'],
    repo,
  );
  const j = JSON.parse(raw);
  return { base: j.baseRefOid, head: j.headRefOid, merge: j.mergeCommit?.oid ?? null };
}

// Parse `git diff --unified=0` output into per-file removed/added line ranges.
// Returns: { files: [{ file, removed: [{start,end}], added: [{start,end}] }], totalChangedFiles }
function parseUnifiedZero(diffText) {
  const files = [];
  let cur = null;
  const lines = diffText.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (cur) files.push(cur);
      cur = { file: null, removed: [], added: [] };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+++ ')) {
      // +++ b/path/to/file
      const p = line.slice(6);
      if (p === '/dev/null') {
        cur.file = null;
      } else {
        cur.file = p;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      // For deleted files, +++ is /dev/null and --- has the path.
      if (cur.file == null) {
        const p = line.slice(6);
        if (p !== '/dev/null') cur.file = p;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      // @@ -a,b +c,d @@   (b and d default to 1 if absent)
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const minusStart = Number(m[1]);
      const minusCount = m[2] === undefined ? 1 : Number(m[2]);
      const plusStart = Number(m[3]);
      const plusCount = m[4] === undefined ? 1 : Number(m[4]);
      if (minusCount > 0) cur.removed.push({ start: minusStart, end: minusStart + minusCount - 1 });
      if (plusCount > 0) cur.added.push({ start: plusStart, end: plusStart + plusCount - 1 });
      // Pure addition (-a,0): use a synthetic ±tol "implicit bug location" range
      // anchored at minusStart so the parent scan has a target.
      if (minusCount === 0) {
        cur.removed.push({ start: minusStart, end: minusStart, implicit: true });
      }
    }
  }
  if (cur) files.push(cur);
  // Strip files we couldn't resolve (binary, mode-only, etc).
  return files.filter((f) => f.file).map((f) => ({ file: f.file, removed: f.removed, added: f.added }));
}

function isAnalyzableFile(file) {
  const ext = path.extname(file).toLowerCase();
  return ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.cs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.py', '.go', '.rs'].includes(ext);
}

async function extractParentFile(repo, baseSha, file, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    const buf = await execFileP('git', ['show', `${baseSha}:${file}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
    await writeFile(dest, buf.stdout);
    return true;
  } catch {
    return false;
  }
}

async function runSemgrep(packs, scanRoot) {
  // --config auto requires metrics on (it picks rules from the registry based on
  // project context). For Gate 0 we accept the metrics tradeoff since this is a
  // one-off benchmark. If `packs` contains 'auto', emit metrics; otherwise off.
  const usesAuto = packs.includes('auto');
  const args = ['scan', '--quiet', '--json', '--timeout', String(SEMGREP_TIMEOUT_PER_FILE_S), '--disable-version-check'];
  if (!usesAuto) args.push('--metrics=off');
  for (const p of packs) { args.push('--config', p); }
  args.push(scanRoot);
  try {
    const { stdout } = await execFileP('semgrep', args, { maxBuffer: 256 * 1024 * 1024, timeout: 600000 });
    const j = JSON.parse(stdout);
    return { ok: true, results: j.results || [], errors: j.errors || [] };
  } catch (err) {
    // Semgrep exits non-zero when findings exist OR on real errors. Try to parse stdout regardless.
    if (err.stdout) {
      try {
        const j = JSON.parse(err.stdout);
        return { ok: true, results: j.results || [], errors: j.errors || [] };
      } catch {}
    }
    return { ok: false, results: [], errors: [{ message: String(err.message || err).slice(0, 500) }] };
  }
}

async function runAstGrep(configPath, scanRoot, repoRoot) {
  // ast-grep needs to find rules relative to its config; the config references
  // `.config/ast-grep/rules`. So we point sg at the repo root with --config = the
  // repo's sgconfig.yml, then restrict scan path. We DON'T scan the parent files
  // in tmpdir because the rule loader resolves rule paths relative to the config
  // file's own directory; that works for any scan path.
  if (!configPath) return { ok: true, results: [], errors: [] };
  try {
    const { stdout } = await execFileP(
      'ast-grep',
      ['scan', '--config', configPath, '--json', scanRoot],
      { maxBuffer: 64 * 1024 * 1024, timeout: 300000, cwd: repoRoot },
    );
    const j = JSON.parse(stdout || '[]');
    return { ok: true, results: j, errors: [] };
  } catch (err) {
    if (err.stdout) {
      try {
        const j = JSON.parse(err.stdout);
        return { ok: true, results: j, errors: [] };
      } catch {}
    }
    return { ok: false, results: [], errors: [{ message: String(err.message || err).slice(0, 500) }] };
  }
}

function findingInBugRange(findingLine, ranges, tol = TOLERANCE_LINES) {
  for (const r of ranges) {
    if (findingLine >= r.start - tol && findingLine <= r.end + tol) return true;
  }
  return false;
}

async function processPr(pr, ctx) {
  const { repo, owner, name, semgrepPacks, astgrepConfig, prToTmp } = ctx;
  const prNum = pr.number;
  const result = {
    number: prNum,
    title: pr.title,
    category: pr.category,
    tags: pr.tags,
    humanReviewComments: pr.humanReviewComments,
    groundTruth: pr.groundTruth,
    base: null, head: null, merge: null,
    files: [],
    totalChangedAnalyzableFiles: 0,
    totalSemgrepFindings: 0,
    totalAstGrepFindings: 0,
    findingsInBugRange: [],
    caught: false,
    errors: [],
    durationMs: 0,
  };
  const t0 = Date.now();
  try {
    const { base, head, merge } = await getPrShas(owner, name, prNum, repo);
    result.base = base; result.head = head; result.merge = merge;
    await ensureSha(repo, base, prNum);
    await ensureSha(repo, head, prNum);

    // Diff base..head with --unified=0; restrict to analyzable files for cost,
    // but record all changed files for reporting.
    const diffText = await git(['diff', '--unified=0', `${base}..${head}`], repo);
    const allFiles = parseUnifiedZero(diffText);
    const files = allFiles.filter((f) => isAnalyzableFile(f.file));
    result.totalChangedAnalyzableFiles = files.length;
    if (files.length === 0) {
      result.errors.push('No analyzable files in diff (all binary/non-source).');
      return result;
    }

    const tmpRoot = await mkdtemp(path.join(tmpdir(), `gate0-pr${prNum}-`));
    prToTmp.set(prNum, tmpRoot);

    const fileEntries = [];
    for (const f of files) {
      // Strip leading a/ or b/ from diff path.
      const cleanPath = f.file.replace(/^[ab]\//, '');
      const dest = path.join(tmpRoot, cleanPath);
      const ok = await extractParentFile(repo, base, cleanPath, dest);
      fileEntries.push({ file: cleanPath, dest, removed: f.removed, added: f.added, extracted: ok });
    }
    result.files = fileEntries.map((e) => ({
      file: e.file,
      removed: e.removed,
      added: e.added,
      extracted: e.extracted,
      semgrepFindings: 0,
      astgrepFindings: 0,
      findingsInBugRange: [],
    }));

    // Run analyzers on the whole tmpRoot (one pass per analyzer for the PR).
    const semgrepRes = await runSemgrep(semgrepPacks, tmpRoot);
    if (!semgrepRes.ok) result.errors.push(`semgrep error: ${semgrepRes.errors[0]?.message}`);

    const astgrepRes = astgrepConfig ? await runAstGrep(astgrepConfig, tmpRoot, ctx.astgrepRepoRoot) : { ok: true, results: [] };
    if (!astgrepRes.ok) result.errors.push(`ast-grep error: ${astgrepRes.errors[0]?.message}`);

    // Map findings back to per-file entries.
    const fileByPath = new Map(result.files.map((e) => [path.join(tmpRoot, e.file), e]));
    for (const r of semgrepRes.results) {
      const filePath = r.path;
      const line = r.start?.line ?? r.line ?? null;
      const ruleId = r.check_id || r.rule_id || 'unknown';
      const entry = fileByPath.get(filePath);
      if (!entry || line == null) continue;
      entry.semgrepFindings += 1;
      if (findingInBugRange(line, entry.removed)) {
        const hit = { tool: 'semgrep', rule: ruleId, line, file: entry.file };
        entry.findingsInBugRange.push(hit);
        result.findingsInBugRange.push(hit);
      }
    }
    for (const r of astgrepRes.results) {
      const filePath = r.file ?? r.path ?? null;
      const line = r.range?.start?.line != null ? r.range.start.line + 1 : (r.line ?? null);
      const ruleId = r.ruleId || r.rule || 'unknown';
      const entry = fileByPath.get(filePath);
      if (!entry || line == null) continue;
      entry.astgrepFindings += 1;
      if (findingInBugRange(line, entry.removed)) {
        const hit = { tool: 'ast-grep', rule: ruleId, line, file: entry.file };
        entry.findingsInBugRange.push(hit);
        result.findingsInBugRange.push(hit);
      }
    }
    result.totalSemgrepFindings = result.files.reduce((s, e) => s + e.semgrepFindings, 0);
    result.totalAstGrepFindings = result.files.reduce((s, e) => s + e.astgrepFindings, 0);
    result.caught = result.findingsInBugRange.length > 0;
  } catch (err) {
    result.errors.push(`fatal: ${String(err.message || err).slice(0, 500)}`);
  } finally {
    result.durationMs = Date.now() - t0;
  }
  return result;
}

function classify(pr, fpNumbers) {
  if (fpNumbers.has(pr.number)) return 'fp-baseline';
  const tags = new Set(pr.tags || []);
  if (tags.has('review-caught-issue')) return 'review-caught-issue';
  if (tags.has('security')) return 'security';
  return 'other';
}

function bucketStats(prResults) {
  const buckets = {};
  for (const r of prResults) {
    const b = r._bucket;
    if (!buckets[b]) buckets[b] = { total: 0, caught: 0, totalFindings: 0, prs: [] };
    buckets[b].total += 1;
    if (r.caught) buckets[b].caught += 1;
    buckets[b].totalFindings += r.totalSemgrepFindings + r.totalAstGrepFindings;
    buckets[b].prs.push({ number: r.number, caught: r.caught, hits: r.findingsInBugRange.length, totalFindings: r.totalSemgrepFindings + r.totalAstGrepFindings });
  }
  return buckets;
}

function classCount(prResults) {
  const byClass = {};
  for (const r of prResults) {
    if (r._bucket !== 'review-caught-issue') continue;
    const cls = (r.tags || []).filter((t) => t !== 'review-caught-issue' && t !== 'security').join('+') || 'unclassified';
    if (!byClass[cls]) byClass[cls] = { caught: 0, total: 0, prs: [] };
    byClass[cls].total += 1;
    if (r.caught) byClass[cls].caught += 1;
    byClass[cls].prs.push({ n: r.number, caught: r.caught });
  }
  return byClass;
}

function summaryMd({ runStamp, repoLabel, prResults, semgrepPacks, astgrepConfig }) {
  const buckets = bucketStats(prResults);
  const rci = buckets['review-caught-issue'] || { caught: 0, total: 0 };
  const rciPct = rci.total ? Math.round((rci.caught / rci.total) * 100) : 0;
  const decision = rciPct >= 30 ? 'PASS' : 'KILL';
  const fp = buckets['fp-baseline'] || { total: 0, totalFindings: 0 };
  const fpAvg = fp.total ? (fp.totalFindings / fp.total).toFixed(1) : '0';
  const flagFp = fp.total > 0 && Number(fpAvg) > 5;
  const cls = classCount(prResults);

  const lines = [];
  lines.push(`# Gate 0 — Run ${runStamp} (${repoLabel})`);
  lines.push('');
  lines.push(`**Decision: ${decision}**`);
  lines.push('');
  lines.push('## Primary kill criterion');
  lines.push('- Target: ≥30% of review-caught-issue PRs have any rule fire in bug\'s changed lines (±5 line tolerance)');
  lines.push(`- Observed: ${rci.caught} / ${rci.total} (${rciPct}%)`);
  lines.push(`- Result: **${decision}**`);
  lines.push('');
  lines.push('## Per-bucket fire rate');
  lines.push('| Bucket | Caught | Total | % | Avg findings/PR |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const [name, b] of Object.entries(buckets)) {
    const pct = b.total ? Math.round((b.caught / b.total) * 100) : 0;
    const avg = b.total ? (b.totalFindings / b.total).toFixed(1) : '0';
    lines.push(`| ${name} | ${b.caught} | ${b.total} | ${pct}% | ${avg} |`);
  }
  lines.push('');
  lines.push('## Per-class fire rate (review-caught-issue)');
  lines.push('| Class tags | Caught | Total |');
  lines.push('| --- | --- | --- |');
  for (const [k, v] of Object.entries(cls)) lines.push(`| ${k} | ${v.caught} | ${v.total} |`);
  lines.push('');
  lines.push('## False-positive baseline');
  lines.push(`- Average analyzer fires per FP-baseline PR: ${fpAvg}`);
  lines.push(`- Flag for Gate 2 if >5: ${flagFp ? 'YES' : 'NO'}`);
  lines.push('');
  lines.push('## Per-PR detail');
  lines.push('| # | bucket | caught | hits | semgrep | astgrep | duration | title |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of prResults) {
    lines.push(`| ${r.number} | ${r._bucket} | ${r.caught ? 'YES' : 'no'} | ${r.findingsInBugRange.length} | ${r.totalSemgrepFindings} | ${r.totalAstGrepFindings} | ${(r.durationMs / 1000).toFixed(1)}s | ${(r.title || '').slice(0, 60)} |`);
  }
  lines.push('');
  lines.push('## Caught PRs (sample of rule fires)');
  for (const r of prResults.filter((p) => p.caught)) {
    const sample = r.findingsInBugRange.slice(0, 3).map((h) => `${h.tool}:${h.rule}@${h.file}:${h.line}`).join(', ');
    lines.push(`- #${r.number} (${r.tags.join(', ')}) — ${sample}`);
  }
  lines.push('');
  lines.push('## Missed PRs');
  for (const r of prResults.filter((p) => !p.caught && p._bucket === 'review-caught-issue')) {
    lines.push(`- #${r.number}: ${r.title}`);
    lines.push(`  - groundTruth: ${(r.groundTruth || '').slice(0, 200)}`);
  }
  lines.push('');
  lines.push('## Configuration');
  lines.push(`- Semgrep packs: ${semgrepPacks.join(', ')}`);
  lines.push(`- ast-grep config: ${astgrepConfig || '(none)'}`);
  lines.push(`- Tolerance: ±${TOLERANCE_LINES} lines`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const required = ['corpus', 'repo', 'out'];
  for (const k of required) {
    if (!args[k]) { console.error(`Missing --${k}`); process.exit(2); }
  }
  const corpusJson = JSON.parse(await readFile(args.corpus, 'utf8'));
  const owner = args.owner || corpusJson.repo.split('/')[0];
  const name = args.name || corpusJson.repo.split('/')[1];
  const semgrepPacks = (args['semgrep-packs'] || 'p/javascript').split(',').map((s) => s.trim()).filter(Boolean);
  const astgrepConfig = args['astgrep-config'] || null;
  const tags = (args.tags || 'review-caught-issue,security,fp-baseline').split(',').map((s) => s.trim());
  const fpNumbers = new Set((args['fp-numbers'] || '').split(',').filter(Boolean).map(Number));

  const repo = path.resolve(args.repo);
  const outDir = path.resolve(args.out);
  await mkdir(outDir, { recursive: true });

  const filtered = corpusJson.prs.filter((pr) => {
    const b = classify(pr, fpNumbers);
    return tags.includes(b);
  });

  console.error(`Running Gate 0 on ${filtered.length} PRs from ${owner}/${name}`);
  console.error(`Semgrep packs: ${semgrepPacks.join(', ')}`);
  console.error(`ast-grep config: ${astgrepConfig || '(none)'}`);
  console.error(`Output: ${outDir}\n`);

  const ctx = { repo, owner, name, semgrepPacks, astgrepConfig, astgrepRepoRoot: repo, prToTmp: new Map() };
  const results = [];
  for (const pr of filtered) {
    process.stderr.write(`#${pr.number} (${pr.tags.join(',')}): `);
    const r = await processPr(pr, ctx);
    r._bucket = classify(pr, fpNumbers);
    results.push(r);
    process.stderr.write(`${r.caught ? 'CAUGHT' : 'miss '} | hits=${r.findingsInBugRange.length} sg=${r.totalSemgrepFindings} ast=${r.totalAstGrepFindings} ${(r.durationMs/1000).toFixed(1)}s${r.errors.length ? ` ERR(${r.errors.length})` : ''}\n`);
    await writeFile(path.join(outDir, `${pr.number}.json`), JSON.stringify(r, null, 2));
  }

  // Cleanup tmp dirs.
  for (const tmp of ctx.prToTmp.values()) {
    try { await rm(tmp, { recursive: true, force: true }); } catch {}
  }

  const runStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const summary = summaryMd({ runStamp, repoLabel: `${owner}/${name}`, prResults: results, semgrepPacks, astgrepConfig });
  await writeFile(path.join(outDir, '__SUMMARY.md'), summary);
  console.error(`\nWrote ${path.join(outDir, '__SUMMARY.md')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
