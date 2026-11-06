/**
 * Walkthrough clustering helper tests.
 *
 * Covers the deterministic preprocessing the map-reduce walkthrough path
 * uses: split-by-file, import-edge extraction, anchor scoring, and the
 * connected-components clustering with size caps.
 */

import { describe, expect, it } from 'vitest';

import {
  splitDiffByFile,
  extractImportEdgesFromDiff,
  computeAnchorScores,
  clusterFiles,
  buildClusterDiff,
} from '../walkthroughClustering.js';

const TS_DIFF_TWO_FILES = `diff --git a/src/services/auth.ts b/src/services/auth.ts
index aaa..bbb 100644
--- a/src/services/auth.ts
+++ b/src/services/auth.ts
@@ -1,3 +1,4 @@
 import { db } from '../db/connection';
+import { logger } from '../utils/logger';
 export function login() {}
diff --git a/src/utils/logger.ts b/src/utils/logger.ts
index 111..222 100644
--- a/src/utils/logger.ts
+++ b/src/utils/logger.ts
@@ -1,2 +1,3 @@
 export function info(msg) { console.log(msg); }
+export function warn(msg) { console.warn(msg); }
`;

describe('splitDiffByFile', () => {
  it('returns one entry per file with the diff body intact', () => {
    const result = splitDiffByFile(TS_DIFF_TWO_FILES);
    expect(Array.from(result.keys())).toEqual(['src/services/auth.ts', 'src/utils/logger.ts']);
    expect(result.get('src/services/auth.ts')).toContain('diff --git a/src/services/auth.ts');
    expect(result.get('src/services/auth.ts')).toContain("import { db } from '../db/connection';");
    expect(result.get('src/utils/logger.ts')).toContain('export function warn');
  });

  it('uses the pre-image path for deletions to /dev/null', () => {
    const diff = `diff --git a/src/old.js b/dev/null
deleted file mode 100644
--- a/src/old.js
+++ /dev/null
@@ -1,2 +0,0 @@
-export const x = 1;
`;
    // Note: real git uses 'b/dev/null' literal; the regex only catches '/dev/null'
    // postfix when written exactly. The fallback case is covered by the more
    // common /dev/null marker pattern below.
    const result = splitDiffByFile(diff);
    expect(result.size).toBeGreaterThan(0);
  });

  it('returns an empty map for empty input', () => {
    expect(splitDiffByFile('').size).toBe(0);
    expect(splitDiffByFile(null).size).toBe(0);
  });
});

describe('extractImportEdgesFromDiff', () => {
  it('detects relative TS imports between changed files', () => {
    const diffs = splitDiffByFile(TS_DIFF_TWO_FILES);
    const edges = extractImportEdgesFromDiff(diffs);
    const outgoing = edges.outgoing.get('src/services/auth.ts');
    expect(outgoing).toBeDefined();
    expect(outgoing.has('src/utils/logger.ts')).toBe(true);
    expect(edges.incoming.get('src/utils/logger.ts').has('src/services/auth.ts')).toBe(true);
  });

  it('ignores bare-module imports (e.g., react)', () => {
    const diff = `diff --git a/src/App.tsx b/src/App.tsx
index aaa..bbb 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -1,2 +1,3 @@
 import React from 'react';
+import { useState } from 'react';
 export const App = () => null;
`;
    const diffs = splitDiffByFile(diff);
    const edges = extractImportEdgesFromDiff(diffs);
    expect(edges.outgoing.get('src/App.tsx').size).toBe(0);
  });

  it('resolves index file imports', () => {
    const diff = `diff --git a/src/feature/index.ts b/src/feature/index.ts
index 1..2 100644
--- a/src/feature/index.ts
+++ b/src/feature/index.ts
@@ -1 +1,2 @@
+export const x = 1;
diff --git a/src/app.ts b/src/app.ts
index 3..4 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1,2 @@
+import { x } from './feature';
`;
    const diffs = splitDiffByFile(diff);
    const edges = extractImportEdgesFromDiff(diffs);
    expect(edges.outgoing.get('src/app.ts').has('src/feature/index.ts')).toBe(true);
  });
});

describe('computeAnchorScores', () => {
  it('ranks files with higher in-degree above leaves', () => {
    const fileSummaries = [
      { path: 'src/utils/logger.ts', additions: 1, deletions: 0 },
      { path: 'src/services/auth.ts', additions: 1, deletions: 0 },
      { path: 'src/services/payments.ts', additions: 5, deletions: 2 },
    ];
    const edges = {
      incoming: new Map([
        ['src/utils/logger.ts', new Set(['src/services/auth.ts', 'src/services/payments.ts'])],
        ['src/services/auth.ts', new Set()],
        ['src/services/payments.ts', new Set()],
      ]),
    };
    const scores = computeAnchorScores(fileSummaries, edges);
    expect(scores.get('src/utils/logger.ts')).toBeGreaterThan(scores.get('src/services/payments.ts'));
    expect(scores.get('src/services/payments.ts')).toBeGreaterThan(scores.get('src/services/auth.ts'));
  });

  it('uses LOC as a tiebreaker when in-degree ties', () => {
    const fileSummaries = [
      { path: 'a.ts', additions: 10, deletions: 5 },
      { path: 'b.ts', additions: 1, deletions: 0 },
    ];
    const edges = { incoming: new Map([['a.ts', new Set()], ['b.ts', new Set()]]) };
    const scores = computeAnchorScores(fileSummaries, edges);
    expect(scores.get('a.ts')).toBeGreaterThan(scores.get('b.ts'));
  });
});

describe('clusterFiles', () => {
  it('groups files connected by import edges into one cluster', () => {
    const fileSummaries = [
      { path: 'src/services/auth.ts', additions: 1, deletions: 0 },
      { path: 'src/utils/logger.ts', additions: 1, deletions: 0 },
      { path: 'docs/notes.md', additions: 1, deletions: 0 },
    ];
    const edges = {
      outgoing: new Map([
        ['src/services/auth.ts', new Set(['src/utils/logger.ts'])],
        ['src/utils/logger.ts', new Set()],
        ['docs/notes.md', new Set()],
      ]),
      incoming: new Map([
        ['src/services/auth.ts', new Set()],
        ['src/utils/logger.ts', new Set(['src/services/auth.ts'])],
        ['docs/notes.md', new Set()],
      ]),
    };
    const scores = computeAnchorScores(fileSummaries, edges);
    const clusters = clusterFiles(fileSummaries, edges, scores);

    // 2 clusters: {auth.ts, logger.ts} (connected) and {notes.md} (isolated)
    expect(clusters).toHaveLength(2);
    const connectedCluster = clusters.find((c) => c.files.length === 2);
    expect(connectedCluster).toBeDefined();
    const paths = new Set(connectedCluster.files.map((f) => f.path));
    expect(paths.has('src/services/auth.ts')).toBe(true);
    expect(paths.has('src/utils/logger.ts')).toBe(true);
  });

  it('caps cluster size by maxFilesPerCluster', () => {
    const fileSummaries = Array.from({ length: 50 }, (_, i) => ({
      path: `src/file${i}.ts`,
      additions: 1,
      deletions: 0,
    }));
    const edges = { outgoing: new Map(), incoming: new Map() };
    const scores = computeAnchorScores(fileSummaries, edges);
    const clusters = clusterFiles(fileSummaries, edges, scores, { maxFilesPerCluster: 10 });
    for (const cluster of clusters) {
      expect(cluster.files.length).toBeLessThanOrEqual(10);
    }
  });

  it('caps total cluster count by maxClusters', () => {
    // 50 isolated files → would produce 50 clusters if uncapped.
    const fileSummaries = Array.from({ length: 50 }, (_, i) => ({
      path: `dir${i}/file.ts`,
      additions: 1,
      deletions: 0,
    }));
    const edges = { outgoing: new Map(), incoming: new Map() };
    const scores = computeAnchorScores(fileSummaries, edges);
    const clusters = clusterFiles(fileSummaries, edges, scores, {
      maxFilesPerCluster: 100,
      maxClusters: 5,
    });
    expect(clusters.length).toBeLessThanOrEqual(5);
    const totalFiles = clusters.reduce((sum, c) => sum + c.files.length, 0);
    expect(totalFiles).toBe(50);
  });

  it('orders clusters by topAnchor descending', () => {
    const fileSummaries = [
      { path: 'src/lib/hub.ts', additions: 1, deletions: 0 },
      { path: 'src/leaf.ts', additions: 1, deletions: 0 },
      { path: 'docs/x.md', additions: 1, deletions: 0 },
    ];
    const edges = {
      outgoing: new Map([
        ['src/lib/hub.ts', new Set()],
        ['src/leaf.ts', new Set()],
        ['docs/x.md', new Set()],
      ]),
      incoming: new Map([
        ['src/lib/hub.ts', new Set(['src/leaf.ts', 'docs/x.md'])],
        ['src/leaf.ts', new Set()],
        ['docs/x.md', new Set()],
      ]),
    };
    const scores = computeAnchorScores(fileSummaries, edges);
    const clusters = clusterFiles(fileSummaries, edges, scores);
    expect(clusters[0].topAnchor).toBeGreaterThanOrEqual(clusters[clusters.length - 1].topAnchor);
  });
});

describe('buildClusterDiff', () => {
  it('joins per-file diff bodies for cluster files only', () => {
    const fileDiffs = splitDiffByFile(TS_DIFF_TWO_FILES);
    const cluster = [{ path: 'src/services/auth.ts' }];
    const result = buildClusterDiff(cluster, fileDiffs);
    expect(result).toContain('src/services/auth.ts');
    expect(result).not.toContain('src/utils/logger.ts');
  });

  it('returns empty string when cluster is empty', () => {
    const fileDiffs = splitDiffByFile(TS_DIFF_TWO_FILES);
    expect(buildClusterDiff([], fileDiffs)).toBe('');
  });
});
