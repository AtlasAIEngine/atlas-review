/**
 * CodeGraph service — wraps the external `@colbymchenry/codegraph` CLI.
 *
 * Owns the project_codegraph_indexes lifecycle:
 *   - initIndex(projectPath, projectId, opts)
 *       Spawns `codegraph init -i` (or `codegraph index`) async, streams
 *       progress, persists rows in project_codegraph_indexes, updates the
 *       projects.codegraph_current_index_id pointer on success.
 *   - getStatus(projectId)
 *       Reads the latest index row from DB. Source of truth for the UI.
 *   - uninit(projectPath, projectId)
 *       Removes the on-disk .codegraph/, marks the latest row 'stale',
 *       clears the current-index pointer. User intent (codegraph_enabled)
 *       is untouched per the spec/status separation.
 *   - setEnabled(projectId, enabled)
 *       Just flips projects.codegraph_enabled. Does NOT start init —
 *       callers (the route) decide whether to chain initIndex.
 *
 * Two-state model: the toggle is the user's desired enablement; reviews
 * only use CodeGraph when the toggle is ON AND a ready index row exists
 * AND its worktree_sha matches reviewHeadSha (invariant I1).
 */

import { spawn, execFile } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { query, getDbType } from '../db/connection.js';

const execFileP = promisify(execFile);

const CODEGRAPH_BIN = process.env.ATLAS_CODEGRAPH_BIN || 'codegraph';
const STATE = Object.freeze({
  INDEXING: 'indexing',
  READY: 'ready',
  ERROR: 'error',
  STALE: 'stale',
});

// Per-project in-flight init lock so concurrent calls collapse to one.
const inFlightInits = new Map(); // projectId -> Promise

// Per-project ring buffer of recent codegraph stdout/stderr lines. Lets the
// UI surface live progress without us having to invent a structured
// progress protocol with the CLI. Survives until the next init resets it
// or the process exits.
const RECENT_LOGS_PER_PROJECT = 80;
const recentLogsByProject = new Map(); // projectId -> Array<{ ts, stream, line }>

function appendLogLine(projectId, stream, line) {
  if (!projectId) return;
  const text = String(line || '').replace(/\r/g, '').trim();
  if (!text) return;
  let buf = recentLogsByProject.get(projectId);
  if (!buf) {
    buf = [];
    recentLogsByProject.set(projectId, buf);
  }
  buf.push({ ts: Date.now(), stream, line: text.slice(0, 2000) });
  if (buf.length > RECENT_LOGS_PER_PROJECT) {
    buf.splice(0, buf.length - RECENT_LOGS_PER_PROJECT);
  }
}

function clearLogsFor(projectId) {
  if (projectId) recentLogsByProject.delete(projectId);
}

/**
 * Snapshot of recent codegraph CLI output for a project. Newest-last.
 * Returned alongside status so the frontend can render a live log panel
 * during indexing without a separate endpoint.
 */
export function getRecentLogs(projectId) {
  if (!projectId) return [];
  const buf = recentLogsByProject.get(projectId);
  return Array.isArray(buf) ? buf.slice() : [];
}

function newId() {
  return randomUUID();
}

function nowSqlExpr() {
  return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
}

async function readCodegraphVersion() {
  try {
    const { stdout } = await execFileP(CODEGRAPH_BIN, ['--version'], { timeout: 5000 });
    return String(stdout || '').trim() || null;
  } catch {
    return null;
  }
}

async function readWorktreeHeadSha(projectPath) {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], {
      cwd: projectPath,
      timeout: 5000,
    });
    return String(stdout || '').trim() || null;
  } catch {
    return null;
  }
}

async function readIndexSizeBytes(projectPath) {
  const indexDir = path.join(projectPath, '.codegraph');
  try {
    const stat = await fsp.stat(indexDir);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  // Sum file sizes under .codegraph/ (one level deep is enough for SQLite + WAL).
  let total = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        try {
          const s = await fsp.stat(full);
          total += Number(s.size) || 0;
        } catch { /* ignore */ }
      }
    }
  }
  await walk(indexDir);
  return total;
}

/**
 * Run `codegraph status --json` to harvest current index statistics.
 * Returns null when the CLI is missing, the project isn't initialized,
 * or the output can't be parsed. Defensive — never throws.
 */
async function readCodegraphStatusJson(projectPath) {
  try {
    const { stdout } = await execFileP(CODEGRAPH_BIN, ['status', projectPath, '--json'], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const txt = String(stdout || '').trim();
    if (!txt) return null;
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/**
 * Pull the most recent row for a project. Returns null when no row exists
 * (i.e. CodeGraph has never been initialized for this project).
 */
export async function getLatestIndexRow(projectId) {
  if (!projectId) return null;
  const result = await query(
    `SELECT id, project_id, state, codegraph_version, worktree_sha,
            started_at, ready_at, files_indexed, total_files,
            nodes, edges, size_bytes, error_message, metadata
       FROM project_codegraph_indexes
      WHERE project_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [projectId]
  );
  return result.rows?.[0] || null;
}

/**
 * Combined project-level status. Reads the projects row (for enablement)
 * and the latest index row (for readiness). Used by the GET status route
 * and by reviewService when computing the I1 gate.
 */
export async function getStatus(projectId) {
  if (!projectId) {
    return {
      enabled: false,
      latestIndex: null,
      effectiveReadyForReview: false,
    };
  }
  const projRes = await query(
    `SELECT codegraph_enabled, codegraph_current_index_id
       FROM projects WHERE id = $1 LIMIT 1`,
    [projectId]
  );
  const projRow = projRes.rows?.[0] || null;
  if (!projRow) return { enabled: false, latestIndex: null, effectiveReadyForReview: false };

  const enabled = projRow.codegraph_enabled === true
    || projRow.codegraph_enabled === 1
    || projRow.codegraph_enabled === '1'
    || projRow.codegraph_enabled === 't'
    || projRow.codegraph_enabled === 'true';

  const latestIndex = await getLatestIndexRow(projectId);
  const effectiveReadyForReview = enabled
    && latestIndex
    && latestIndex.state === STATE.READY;
  // Note: caller is responsible for the worktree_sha === reviewHeadSha
  // check at review time. That gate lives in reviewService.js because it
  // needs the reviewHeadSha, which isn't known at status-fetch time.

  return { enabled, latestIndex, effectiveReadyForReview };
}

/**
 * Look up a ready index row that matches a specific worktree_sha.
 * The I1 gate at review time uses this to decide whether to enable
 * CodeGraph for the review.
 */
export async function findReadyIndexForSha(projectId, worktreeSha) {
  if (!projectId || !worktreeSha) return null;
  const result = await query(
    `SELECT id, state, codegraph_version, worktree_sha,
            files_indexed, total_files, nodes, edges, size_bytes
       FROM project_codegraph_indexes
      WHERE project_id = $1
        AND state = 'ready'
        AND worktree_sha = $2
      ORDER BY started_at DESC
      LIMIT 1`,
    [projectId, worktreeSha]
  );
  return result.rows?.[0] || null;
}

/**
 * Toggle the user's desired enablement. Does NOT start indexing; the
 * caller decides whether to chain initIndex when enabling on a project
 * with no ready index.
 */
export async function setEnabled(projectId, enabled) {
  if (!projectId) throw new Error('setEnabled: projectId required');
  const value = enabled === true || enabled === 'true' || enabled === 1;
  const isSqlite = getDbType() === 'sqlite';
  const dbValue = isSqlite ? (value ? 1 : 0) : value;
  await query(
    `UPDATE projects SET codegraph_enabled = $1, updated_at = ${nowSqlExpr()} WHERE id = $2`,
    [dbValue, projectId]
  );
  return value;
}

async function insertIndexRow({ projectId, codegraphVersion, worktreeSha }) {
  const isSqlite = getDbType() === 'sqlite';
  const id = isSqlite ? newId() : null;
  if (isSqlite) {
    await query(
      `INSERT INTO project_codegraph_indexes
         (id, project_id, state, codegraph_version, worktree_sha, started_at)
       VALUES ($1, $2, 'indexing', $3, $4, ${nowSqlExpr()})`,
      [id, projectId, codegraphVersion, worktreeSha]
    );
    return id;
  }
  const res = await query(
    `INSERT INTO project_codegraph_indexes
       (project_id, state, codegraph_version, worktree_sha, started_at)
     VALUES ($1, 'indexing', $2, $3, ${nowSqlExpr()})
     RETURNING id`,
    [projectId, codegraphVersion, worktreeSha]
  );
  return res.rows?.[0]?.id || null;
}

// Allowlist of columns updateIndexRow may write. Per CLAUDE.md, dynamic
// SQL column names must be validated against a Set even when values are
// parameterized — parameter binding does not protect identifiers.
const UPDATE_INDEX_ROW_COLUMNS = new Set([
  'state',
  'ready_at',
  'files_indexed',
  'total_files',
  'nodes',
  'edges',
  'size_bytes',
  'error_message',
  'metadata',
]);

async function updateIndexRow(rowId, patch) {
  if (!rowId || !patch) return;
  const cols = [];
  const vals = [];
  let n = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (!UPDATE_INDEX_ROW_COLUMNS.has(k)) continue;
    cols.push(`${k} = $${n++}`);
    vals.push(v);
  }
  if (cols.length === 0) return;
  vals.push(rowId);
  await query(
    `UPDATE project_codegraph_indexes SET ${cols.join(', ')} WHERE id = $${n}`,
    vals
  );
}

async function setCurrentIndexPointer(projectId, indexId) {
  await query(
    `UPDATE projects SET codegraph_current_index_id = $1, updated_at = ${nowSqlExpr()} WHERE id = $2`,
    [indexId, projectId]
  );
}

/**
 * Mark every prior non-stale, non-error row stale on this project so a
 * fresh init starts from a clean "latest row" semantics. Errors stay
 * errors (useful history); only readys and any orphaned indexings
 * (shouldn't normally exist) get superseded.
 */
async function supersedePriorRows(projectId) {
  await query(
    `UPDATE project_codegraph_indexes
        SET state = 'stale'
      WHERE project_id = $1
        AND state IN ('ready', 'indexing')`,
    [projectId]
  );
}

/**
 * Parse a stdout line from `codegraph init -i` / `codegraph index` and
 * extract progress hints. The CLI doesn't document a stable JSON event
 * stream for stdout, so we sniff common patterns ("Indexing 47/100",
 * "Parsing foo.ts (12/100)", etc.) and fall back to indeterminate
 * progress when nothing parses.
 *
 * Returns { phase, filesProcessed, totalFiles } | null
 */
function parseProgressLine(line) {
  if (!line) return null;
  const trimmed = String(line).trim();
  if (!trimmed) return null;

  // "Indexed N/M files" or "Parsing N/M" or just "(N/M)"
  const ratio = trimmed.match(/\((\d+)\s*\/\s*(\d+)\)/) || trimmed.match(/(\d+)\s*\/\s*(\d+)\s*files?/i);
  if (ratio) {
    const current = Number(ratio[1]);
    const total = Number(ratio[2]);
    if (Number.isFinite(current) && Number.isFinite(total)) {
      let phase = 'indexing';
      const lower = trimmed.toLowerCase();
      if (lower.includes('parsing')) phase = 'parsing';
      else if (lower.includes('resolving') || lower.includes('reference')) phase = 'resolving';
      else if (lower.includes('writing') || lower.includes('finaliz')) phase = 'writing';
      return { phase, filesProcessed: current, totalFiles: total };
    }
  }

  // Phase-only signal without ratios.
  if (/parsing/i.test(trimmed)) return { phase: 'parsing' };
  if (/resolving|references/i.test(trimmed)) return { phase: 'resolving' };
  if (/writing|finaliz/i.test(trimmed)) return { phase: 'writing' };
  if (/index(ing)?/i.test(trimmed)) return { phase: 'indexing' };
  return null;
}

/**
 * Initialize / re-index a project. Two-phase by design so callers (the
 * codegraph route) can `await` to a point where the indexing row exists
 * in the DB, then let the actual spawn run in the background:
 *
 *   1. SYNCHRONOUS PREP (awaited): validate path, read CLI version + git
 *      HEAD SHA, supersede prior ready/indexing rows, insert the new
 *      'indexing' row. Once this returns, `getStatus()` will see the row.
 *   2. BACKGROUND SPAWN: spawn `codegraph init -i`, stream stdout/stderr
 *      into the per-project ring buffer, update the row to 'ready' or
 *      'error' on exit.
 *
 * Idempotent per project: if an init is already in flight, the existing
 * background promise is returned and a new row is NOT created.
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {string} opts.projectPath  Filesystem path (must be a git worktree for I1).
 * @param {(progress) => void} [opts.onProgress]  Per-progress-line callback.
 * @returns {Promise<{ ok: boolean, indexId: string|null, error?: string, alreadyRunning?: boolean }>}
 *   Resolves once the row has been inserted (or the prep failed). The
 *   `_background` field, when present, is the promise that resolves when
 *   the actual indexing finishes — callers can ignore it for fire-and-
 *   forget, or await it for completion (only useful in tests).
 */
export async function initIndex({ projectId, projectPath, onProgress = null }) {
  if (!projectId) throw new Error('initIndex: projectId required');
  if (!projectPath) throw new Error('initIndex: projectPath required');

  const existing = inFlightInits.get(projectId);
  if (existing) {
    return { ok: true, indexId: null, alreadyRunning: true, _background: existing };
  }

  // ===== SYNCHRONOUS PREP =====
  // Errors here surface to the caller (the route) immediately and no row
  // is created. Once we leave this block, the row IS in the DB and the
  // status endpoint will report state='indexing'.
  let rowId = null;
  let codegraphVersion = null;
  let worktreeSha = null;
  try {
    const stat = await fsp.stat(projectPath);
    if (!stat.isDirectory()) {
      return { ok: false, indexId: null, error: `projectPath is not a directory: ${projectPath}` };
    }
  } catch (err) {
    return { ok: false, indexId: null, error: `projectPath not accessible: ${err?.message || err}` };
  }
  try {
    [codegraphVersion, worktreeSha] = await Promise.all([
      readCodegraphVersion(),
      readWorktreeHeadSha(projectPath),
    ]);
    await supersedePriorRows(projectId);
    rowId = await insertIndexRow({ projectId, codegraphVersion, worktreeSha });
  } catch (err) {
    return { ok: false, indexId: null, error: `init prep failed: ${err?.message || err}` };
  }

  clearLogsFor(projectId);
  appendLogLine(projectId, 'system', `codegraph init -i (version ${codegraphVersion || 'unknown'}, sha ${worktreeSha?.slice(0, 12) || 'unknown'})`);

  // ===== BACKGROUND SPAWN =====
  const background = (async () => {
    const startedAt = Date.now();
    try {
      const child = spawn(CODEGRAPH_BIN, ['init', '-i', projectPath], {
        cwd: projectPath,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stderrChunks = [];
      let stdoutBuffer = '';
      let stderrBuffer = '';

      const processStreamLine = (line, stream) => {
        appendLogLine(projectId, stream, line);
        const progress = parseProgressLine(line);
        if (progress) {
          const patch = {};
          if (Number.isFinite(progress.filesProcessed)) patch.files_indexed = progress.filesProcessed;
          if (Number.isFinite(progress.totalFiles)) patch.total_files = progress.totalFiles;
          if (Object.keys(patch).length > 0) {
            updateIndexRow(rowId, patch).catch(() => { /* swallow */ });
          }
          if (typeof onProgress === 'function') {
            try { onProgress(progress); } catch { /* swallow */ }
          }
        }
      };

      child.stdout?.on('data', (buf) => {
        stdoutBuffer += buf.toString('utf8');
        let nl;
        while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
          processStreamLine(stdoutBuffer.slice(0, nl), 'stdout');
          stdoutBuffer = stdoutBuffer.slice(nl + 1);
        }
      });

      child.stderr?.on('data', (buf) => {
        stderrChunks.push(buf);
        stderrBuffer += buf.toString('utf8');
        let nl;
        while ((nl = stderrBuffer.indexOf('\n')) >= 0) {
          processStreamLine(stderrBuffer.slice(0, nl), 'stderr');
          stderrBuffer = stderrBuffer.slice(nl + 1);
        }
      });

      const exitCode = await new Promise((resolve, reject) => {
        child.on('error', (err) => reject(err));
        child.on('exit', (code) => resolve(code));
      });

      // Flush any trailing bytes (lines without final newline).
      if (stdoutBuffer.trim()) processStreamLine(stdoutBuffer, 'stdout');
      if (stderrBuffer.trim()) processStreamLine(stderrBuffer, 'stderr');

      if (exitCode !== 0) {
        const stderrTxt = Buffer.concat(stderrChunks).toString('utf8').slice(-2000);
        const msg = `codegraph init exited with code ${exitCode}: ${stderrTxt.trim() || 'no stderr'}`;
        appendLogLine(projectId, 'system', msg);
        await updateIndexRow(rowId, {
          state: STATE.ERROR,
          error_message: msg,
          ready_at: null,
        });
        return { ok: false, indexId: rowId, error: msg };
      }

      // Harvest stats. Best-effort — index is still valid if these fail.
      const [statusJson, sizeBytes] = await Promise.all([
        readCodegraphStatusJson(projectPath),
        readIndexSizeBytes(projectPath),
      ]);

      const nodes = Number(statusJson?.nodes ?? statusJson?.stats?.nodes) || null;
      const edges = Number(statusJson?.edges ?? statusJson?.stats?.edges) || null;
      const filesIndexed = Number(
        statusJson?.files_indexed
          ?? statusJson?.filesIndexed
          ?? statusJson?.stats?.files
      ) || null;

      const readyPatch = {
        state: STATE.READY,
        ready_at: getDbType() === 'sqlite' ? new Date().toISOString() : new Date(),
        size_bytes: sizeBytes,
        error_message: null,
      };
      if (nodes !== null) readyPatch.nodes = nodes;
      if (edges !== null) readyPatch.edges = edges;
      if (filesIndexed !== null) {
        readyPatch.files_indexed = filesIndexed;
        readyPatch.total_files = filesIndexed;
      }
      await updateIndexRow(rowId, readyPatch);
      await setCurrentIndexPointer(projectId, rowId);

      const elapsedMs = Date.now() - startedAt;
      appendLogLine(projectId, 'system', `Index ready in ${(elapsedMs / 1000).toFixed(1)}s${sizeBytes ? ` (${Math.round(sizeBytes / 1024)} KB on disk)` : ''}.`);
      return { ok: true, indexId: rowId };
    } catch (err) {
      const msg = err?.message || String(err);
      appendLogLine(projectId, 'system', `init failed: ${msg.slice(0, 300)}`);
      await updateIndexRow(rowId, {
        state: STATE.ERROR,
        error_message: msg.slice(0, 2000),
      }).catch(() => { /* swallow */ });
      return { ok: false, indexId: rowId, error: msg };
    } finally {
      inFlightInits.delete(projectId);
    }
  })();

  inFlightInits.set(projectId, background);
  return { ok: true, indexId: rowId, _background: background };
}

/**
 * Remove the on-disk .codegraph/ index and mark the latest row stale.
 * User intent (codegraph_enabled) is left untouched — per T7 of the
 * acceptance tests, Remove Index does NOT disable the toggle.
 */
export async function uninit({ projectId, projectPath }) {
  if (!projectId) throw new Error('uninit: projectId required');
  if (!projectPath) throw new Error('uninit: projectPath required');

  // Run `codegraph uninit --force` first so the CLI cleans up any
  // process-level state (watchers, etc). Best-effort.
  try {
    await execFileP(CODEGRAPH_BIN, ['uninit', projectPath, '--force'], { timeout: 15_000 });
  } catch {
    // Fall back to filesystem removal even if the CLI errors.
  }
  const indexDir = path.join(projectPath, '.codegraph');
  try {
    await fsp.rm(indexDir, { recursive: true, force: true });
  } catch { /* ignore */ }

  // Supersede the latest row.
  await query(
    `UPDATE project_codegraph_indexes
        SET state = 'stale'
      WHERE project_id = $1
        AND state IN ('ready', 'indexing')`,
    [projectId]
  );
  await setCurrentIndexPointer(projectId, null);
  return { ok: true };
}

/**
 * True when CodeGraph is installed on PATH. Routes use this to decide
 * whether to surface a "CLI not installed" error rather than silently
 * letting init fail.
 */
export async function isCliAvailable() {
  return Boolean(await readCodegraphVersion());
}

export const __testables = {
  parseProgressLine,
  STATE,
};
