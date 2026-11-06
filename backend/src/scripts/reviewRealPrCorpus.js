import fs from 'fs/promises';
import path from 'path';

export const DEFAULT_REAL_PR_CORPUS_PATH = 'config/review-harness-benchmarks/project-black/pr-corpus.json';

function normalizeSelectionStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'reserve' ? 'reserve' : 'selected';
}

function normalizeBugClasses(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function normalizeEntry(entry = {}, index = 0) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Real PR corpus entry ${index} must be an object.`);
  }

  const id = String(entry.id || '').trim();
  if (!id) {
    throw new Error(`Real PR corpus entry ${index} is missing an id.`);
  }

  const prNumber = Number(entry.prNumber);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Real PR corpus entry ${id} is missing a valid prNumber.`);
  }

  return {
    ...entry,
    id,
    prNumber,
    selectionStatus: normalizeSelectionStatus(entry.selectionStatus),
    priority: Number.isInteger(Number(entry.priority)) ? Number(entry.priority) : (index + 1),
    bugClasses: normalizeBugClasses(entry.bugClasses),
  };
}

export async function loadRealPrCorpus(manifestPath = DEFAULT_REAL_PR_CORPUS_PATH, options = {}) {
  const cwd = options.cwd || process.cwd();
  const resolvedPath = path.resolve(cwd, manifestPath);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse real PR corpus at ${resolvedPath}: ${error.message}`);
  }

  const entries = Array.isArray(parsed?.entries) ? parsed.entries.map((entry, index) => normalizeEntry(entry, index)) : [];
  return {
    path: resolvedPath,
    repositoryFullName: parsed?.repositoryFullName || null,
    surface: parsed?.surface || 'pr_review',
    fixtureSet: parsed?.fixtureSet || null,
    selectionPrinciples: Array.isArray(parsed?.selectionPrinciples) ? parsed.selectionPrinciples : [],
    entries,
  };
}

export function filterRealPrCorpusEntries(entries = [], options = {}) {
  const selectionStatus = options.selectionStatus
    ? normalizeSelectionStatus(options.selectionStatus)
    : null;
  const maxSizeClass = typeof options.maxSizeClass === 'string'
    ? String(options.maxSizeClass).trim().toLowerCase()
    : null;
  const sizeOrder = ['tiny', 'small', 'small_medium', 'medium', 'large'];

  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    if (selectionStatus && entry.selectionStatus !== selectionStatus) return false;
    if (!maxSizeClass) return true;
    const entrySize = String(entry?.tokenProfile?.sizeClass || '').trim().toLowerCase();
    const entryIndex = sizeOrder.indexOf(entrySize);
    const limitIndex = sizeOrder.indexOf(maxSizeClass);
    if (entryIndex === -1 || limitIndex === -1) return true;
    return entryIndex <= limitIndex;
  });
}

export function rankRealPrCorpusEntries(entries = []) {
  return [...(Array.isArray(entries) ? entries : [])].sort((left, right) => {
    const selectionDelta = (
      (left.selectionStatus === 'selected' ? 0 : 1)
      - (right.selectionStatus === 'selected' ? 0 : 1)
    );
    if (selectionDelta !== 0) return selectionDelta;
    const priorityDelta = Number(left.priority || 0) - Number(right.priority || 0);
    if (priorityDelta !== 0) return priorityDelta;
    return Number(left.prNumber || 0) - Number(right.prNumber || 0);
  });
}

export function summarizeRealPrCorpus(entries = []) {
  const ranked = rankRealPrCorpusEntries(entries);
  const selected = ranked.filter((entry) => entry.selectionStatus === 'selected');
  const reserve = ranked.filter((entry) => entry.selectionStatus === 'reserve');
  const bugClassCounts = {};
  for (const entry of ranked) {
    for (const bugClass of normalizeBugClasses(entry.bugClasses)) {
      bugClassCounts[bugClass] = (bugClassCounts[bugClass] || 0) + 1;
    }
  }
  return {
    totalEntries: ranked.length,
    selectedCount: selected.length,
    reserveCount: reserve.length,
    selectedPrNumbers: selected.map((entry) => entry.prNumber),
    reservePrNumbers: reserve.map((entry) => entry.prNumber),
    bugClassCounts,
    highestPriority: ranked[0]
      ? {
          id: ranked[0].id,
          prNumber: ranked[0].prNumber,
          title: ranked[0].title || null,
        }
      : null,
  };
}
