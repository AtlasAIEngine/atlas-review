/**
 * Walkthrough Clustering
 *
 * Deterministic preprocessing for the map-reduce walkthrough path. Splits a
 * raw diff into per-file segments, extracts a coarse import-edge graph from
 * the diff text, computes anchor scores by in-degree among changed files,
 * and clusters files by shared imports + directory affinity so each cluster
 * can be narrated by a separate LLM call.
 *
 * The graph is intentionally cheap and partial: regex over the diff text,
 * not a full AST. We only need a "good enough" signal for grouping +
 * ranking — the LLM still does the actual narration per cluster.
 */

const DEFAULT_MAX_FILES_PER_CLUSTER = 30;
const DEFAULT_MAX_CLUSTERS = 12;

/**
 * Split a unified diff into a Map<path, fileDiffText>. The path is the
 * post-image path (or pre-image when post is /dev/null).
 *
 * @param {string} diff
 * @returns {Map<string, string>}
 */
export function splitDiffByFile(diff) {
  const out = new Map();
  const source = String(diff || '');
  if (!source.trim()) return out;

  const lines = source.split(/\r?\n/);
  let currentPath = null;
  let currentBuf = [];

  const flush = () => {
    if (currentPath && currentBuf.length > 0) {
      out.set(currentPath, currentBuf.join('\n'));
    }
    currentPath = null;
    currentBuf = [];
  };

  for (const line of lines) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      flush();
      // Real git diffs emit `b/dev/null` for deletions, which the regex
      // captures as 'dev/null'. Some tools also emit `b//dev/null`. Treat
      // both as the deletion sentinel and use the pre-image path so the
      // deleted file is keyed under its real path.
      const isDeletedTarget = header[2] === '/dev/null' || header[2] === 'dev/null';
      currentPath = isDeletedTarget ? header[1] : header[2];
      currentBuf = [line];
      continue;
    }
    if (currentPath) currentBuf.push(line);
  }
  flush();
  return out;
}

/**
 * Resolve a relative-import specifier against an importer file's path.
 * Returns a normalized POSIX path relative to repo root, or null if the
 * specifier is non-relative (e.g., bare module name like 'react').
 *
 * Note: this is conservative — we don't attempt to resolve aliased imports
 * (tsconfig paths, webpack resolve.alias) or auto-append index files. The
 * goal is to detect changed-file → changed-file edges, which is good enough
 * for clustering and ranking.
 */
function resolveRelativeImport(importerPath, specifier) {
  const spec = String(specifier || '').trim();
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const importerDir = importerPath.replace(/\\/g, '/').split('/').slice(0, -1);
  const parts = spec.replace(/\\/g, '/').split('/');
  const stack = [...importerDir];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/**
 * Match an importer's resolved-but-extensionless target against a set of
 * candidate paths from the changed-file manifest. Tries:
 *   - exact match
 *   - target + common extension
 *   - target + '/index' + common extension
 */
const COMMON_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const COMMON_INDEX_SUFFIXES = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function findMatchingTarget(target, candidatePaths) {
  if (!target) return null;
  if (candidatePaths.has(target)) return target;
  for (const ext of COMMON_EXTENSIONS) {
    const withExt = `${target}${ext}`;
    if (candidatePaths.has(withExt)) return withExt;
  }
  for (const suffix of COMMON_INDEX_SUFFIXES) {
    const withIndex = `${target}${suffix}`;
    if (candidatePaths.has(withIndex)) return withIndex;
  }
  return null;
}

/**
 * Per-file regex extractor. Pulls all import specifiers from a file's diff
 * text — both added and unchanged lines — for the languages we care about.
 *
 * Regexes operate on the diff body; that's lossy (only hunks are present)
 * but most import statements live near the top of a file and tend to appear
 * in either the file's '@@' header context lines or near their own changes.
 * Good enough for clustering; not an exhaustive dependency analysis.
 */
function extractSpecifiersFromDiffBody(diffText) {
  const specs = new Set();
  const text = String(diffText || '');
  if (!text) return specs;

  // JS/TS: import ... from '...';   import('...');   require('...')
  const jsRegex = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let match;
  while ((match = jsRegex.exec(text)) !== null) {
    specs.add(match[1]);
  }

  // Python: from x.y import z   |   import x.y
  const pyRegex = /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
  while ((match = pyRegex.exec(text)) !== null) {
    const spec = match[1] || match[2];
    if (spec) specs.add(spec);
  }

  // Go: import "..." (single) and import ( "..." ) (block) — simple form
  const goRegex = /import\s+(?:\(\s*([^)]*)\)|"([^"]+)")/g;
  while ((match = goRegex.exec(text)) !== null) {
    if (match[1]) {
      const inner = match[1];
      const inside = /"([^"]+)"/g;
      let m2;
      while ((m2 = inside.exec(inner)) !== null) specs.add(m2[1]);
    } else if (match[2]) {
      specs.add(match[2]);
    }
  }

  return specs;
}

/**
 * Build the import-edge graph among changed files.
 *
 * @param {Map<string, string>} fileDiffs - per-file diff text
 * @returns {{ outgoing: Map<string, Set<string>>, incoming: Map<string, Set<string>> }}
 */
export function extractImportEdgesFromDiff(fileDiffs) {
  const outgoing = new Map();
  const incoming = new Map();
  const candidatePaths = new Set(fileDiffs.keys());

  for (const path of candidatePaths) {
    outgoing.set(path, new Set());
    incoming.set(path, new Set());
  }

  for (const [importer, body] of fileDiffs.entries()) {
    const specs = extractSpecifiersFromDiffBody(body);
    for (const spec of specs) {
      const resolved = resolveRelativeImport(importer, spec);
      if (!resolved) continue;
      const target = findMatchingTarget(resolved, candidatePaths);
      if (!target || target === importer) continue;
      outgoing.get(importer).add(target);
      incoming.get(target).add(importer);
    }
  }

  return { outgoing, incoming };
}

/**
 * Compute anchor scores by in-degree among changed files. A file imported
 * by many other changed files is a "hub" — likely the file the reviewer
 * should look at first because its changes ripple outward.
 *
 * Score ties are broken by total LOC (additions + deletions) to keep
 * ordering deterministic.
 *
 * @param {Array<{path: string, additions: number, deletions: number}>} fileSummaries
 * @param {{ incoming: Map<string, Set<string>> }} edges
 * @returns {Map<string, number>}
 */
export function computeAnchorScores(fileSummaries, edges) {
  const scores = new Map();
  if (!Array.isArray(fileSummaries)) return scores;
  const inDegree = edges?.incoming || new Map();

  for (const file of fileSummaries) {
    const path = String(file?.path || '');
    if (!path) continue;
    const inboundCount = inDegree.get(path)?.size || 0;
    const loc = (Number(file.additions) || 0) + (Number(file.deletions) || 0);
    // Inbound count dominates; LOC tiebreak fits in the integer range below
    // typical PR sizes without overflowing.
    scores.set(path, inboundCount * 10000 + loc);
  }
  return scores;
}

/**
 * Top-2 directory prefix for clustering by area. Files at repo root or with
 * a single segment land in '(root)' bucket.
 */
function directoryKey(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) return '(root)';
  // Use up to 2 leading segments as the area key.
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

/**
 * Union-Find for connected components.
 */
class UnionFind {
  constructor(items) {
    this.parent = new Map();
    for (const item of items) this.parent.set(item, item);
  }
  find(x) {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Cluster changed files by (a) connected components in the import graph,
 * (b) directory affinity within and across components, and (c) a per-cluster
 * size cap to keep prompts bounded.
 *
 * Output clusters are sorted by the highest anchor score they contain, so
 * downstream code can run high-priority clusters first if it wants.
 *
 * @param {Array<{path: string, additions: number, deletions: number}>} fileSummaries
 * @param {{ outgoing: Map<string, Set<string>> }} edges
 * @param {Map<string, number>} anchorScores
 * @param {{ maxFilesPerCluster?: number, maxClusters?: number }} [options]
 * @returns {Array<{ key: string, files: Array<object>, topAnchor: number }>}
 */
export function clusterFiles(fileSummaries, edges, anchorScores, options = {}) {
  const maxFilesPerCluster = Math.max(2, options.maxFilesPerCluster || DEFAULT_MAX_FILES_PER_CLUSTER);
  const maxClusters = Math.max(1, options.maxClusters || DEFAULT_MAX_CLUSTERS);
  const files = Array.isArray(fileSummaries) ? fileSummaries.filter((f) => f?.path) : [];
  if (files.length === 0) return [];

  // Step 1: connected components from import edges.
  const paths = files.map((f) => f.path);
  const uf = new UnionFind(paths);
  const outgoing = edges?.outgoing || new Map();
  for (const [from, targets] of outgoing.entries()) {
    if (!uf.parent.has(from)) continue;
    for (const to of targets) {
      if (!uf.parent.has(to)) continue;
      uf.union(from, to);
    }
  }

  // Step 2: bucket files by component root, then by directory within each
  // component (helps split big monorepo components like 'src/' into areas).
  const byComponent = new Map();
  for (const file of files) {
    const root = uf.find(file.path);
    if (!byComponent.has(root)) byComponent.set(root, []);
    byComponent.get(root).push(file);
  }

  const rawClusters = [];
  for (const [, componentFiles] of byComponent.entries()) {
    if (componentFiles.length <= maxFilesPerCluster) {
      rawClusters.push(componentFiles);
      continue;
    }
    // Subdivide a large component by directory, then size-cap.
    const byDir = new Map();
    for (const file of componentFiles) {
      const key = directoryKey(file.path);
      if (!byDir.has(key)) byDir.set(key, []);
      byDir.get(key).push(file);
    }
    for (const [, dirFiles] of byDir.entries()) {
      for (let i = 0; i < dirFiles.length; i += maxFilesPerCluster) {
        rawClusters.push(dirFiles.slice(i, i + maxFilesPerCluster));
      }
    }
  }

  // Step 3: annotate clusters with key + topAnchor, sort by topAnchor desc.
  const annotated = rawClusters.map((clusterFilesList) => {
    const topAnchor = clusterFilesList.reduce(
      (max, f) => Math.max(max, anchorScores?.get(f.path) || 0),
      0,
    );
    const sharedKey = directoryKey(clusterFilesList[0].path);
    return {
      key: sharedKey,
      files: clusterFilesList,
      topAnchor,
    };
  });
  annotated.sort((a, b) => b.topAnchor - a.topAnchor);

  // Step 4: cap cluster count by merging the smallest tail clusters together
  // — but never exceed the per-cluster size cap. Pathological inputs (many
  // isolated files) get repacked into chunks of <= maxFilesPerCluster so the
  // LLM prompt always stays bounded; cluster count may exceed the soft cap.
  if (annotated.length <= maxClusters) return annotated;
  const head = annotated.slice(0, maxClusters - 1);
  const tail = annotated.slice(maxClusters - 1);
  const tailFiles = tail.flatMap((c) => c.files);
  const tailTopAnchor = tail.reduce((max, c) => Math.max(max, c.topAnchor), 0);
  const tailKey = tail[0].key;
  const repackedTail = [];
  for (let i = 0; i < tailFiles.length; i += maxFilesPerCluster) {
    repackedTail.push({
      key: tailKey,
      files: tailFiles.slice(i, i + maxFilesPerCluster),
      topAnchor: tailTopAnchor,
    });
  }
  return [...head, ...repackedTail];
}

/**
 * Concatenate the per-file diff bodies for the given paths into one
 * cluster-scoped diff string.
 *
 * @param {Array<{path: string}>} clusterFiles
 * @param {Map<string, string>} fileDiffs
 * @returns {string}
 */
export function buildClusterDiff(clusterFiles, fileDiffs) {
  if (!Array.isArray(clusterFiles) || clusterFiles.length === 0) return '';
  const parts = [];
  for (const file of clusterFiles) {
    const body = fileDiffs.get(file.path);
    if (body) parts.push(body);
  }
  return parts.join('\n');
}

export default {
  splitDiffByFile,
  extractImportEdgesFromDiff,
  computeAnchorScores,
  clusterFiles,
  buildClusterDiff,
};
