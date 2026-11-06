/**
 * FileTreeList — grouped file list for the Direction C Files mode. Fetches
 * the changed-files summary for a branch / workspace / PR review and renders
 * the same filter/group model used by the main changed-files diff pane.
 *
 * Clicking a row calls `onSelectFile` which the parent wires to
 * TrustDiffViewer's `scrollToFileRef` so the right-pane diff focuses on
 * the chosen file.
 */

import { useEffect, useMemo, useState } from 'react';
import { branchReviewApi, prReviewApi, workspaceReviewApi } from '@/services/api';
import type { BranchReviewFileSummary, ReviewFileFilter, ReviewResult, RiskLevel } from '@/types';
import { FileRow } from './primitives/FileRow';
import { getReviewSegmentButtonStyle } from './ReviewChrome';
import {
  buildReviewFileTree,
  getReviewFileTreeVisibleState,
  type ReviewFileTreeEntry,
  type ReviewFileTreeFilter,
  type ReviewFileTreeVisibleState,
} from './reviewPanelUtils';

const SMART_FOLDER_TREE_THRESHOLD = 0;

export interface FileTreeListProps {
  projectId: string;
  branchReviewId?: string;
  workspaceReviewId?: string;
  prReviewId?: string;
  selectedPath?: string | null;
  activeFileFilter?: ReviewFileFilter | null;
  onSelectFileFilter?: (filter: ReviewFileFilter | null) => void;
  onSelectFile?: (path: string) => void;
  refreshToken?: number;
  // Override for the backend's default visible-file cap (200). When the user
  // clicks the "Show 50 more files" footer, the parent bumps this number and
  // we re-fetch. Pass the *current* server-confirmed visible count so the
  // parent doesn't have to assume a backend default — the backend cap is
  // configurable via ATLAS_VISIBLE_REVIEW_FILE_LIMIT and may not be 200.
  visibleFileLimit?: number;
  onLoadMoreFiles?: (currentVisibleCount: number) => void;
}

interface FileEntry {
  path: string;
  additions: number;
  deletions: number;
  status: string;
  oldPath: string | null;
}

interface FileTreeManifestSummary {
  visibleCount: number;
  totalCount: number;
  hiddenCount: number;
  isCapped: boolean;
}

interface FileTreeData {
  files: FileEntry[];
  review: ReviewResult | null;
  summary: FileTreeManifestSummary | null;
}

export function FileTreeList({
  projectId,
  branchReviewId,
  workspaceReviewId,
  prReviewId,
  selectedPath = null,
  activeFileFilter = null,
  onSelectFileFilter,
  onSelectFile,
  refreshToken = 0,
  visibleFileLimit,
  onLoadMoreFiles,
}: FileTreeListProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [review, setReview] = useState<ReviewResult | null>(null);
  const [summary, setSummary] = useState<FileTreeManifestSummary | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Distinguish initial load (full skeleton) from incremental "show more"
      // loads (keep existing list visible, show subtle footer spinner).
      if (files.length === 0) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const data = await fetchFileTreeData({
          projectId,
          branchReviewId,
          workspaceReviewId,
          prReviewId,
          visibleFileLimit,
        });
        if (cancelled) return;
        setFiles(data.files.map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          status: f.status,
          oldPath: f.oldPath,
        })));
        setReview(data.review);
        setSummary(data.summary);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load files');
        setFiles([]);
        setReview(null);
        setSummary(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    }
    void load();
    return () => { cancelled = true; };
    // `files.length` intentionally omitted — its only role is to choose the
    // skeleton vs. footer-spinner UX, and including it would cause a rerun
    // every time files load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, branchReviewId, workspaceReviewId, prReviewId, refreshToken, visibleFileLimit]);

  const tree = useMemo(() => buildReviewFileTree({ files, review }), [files, review]);
  const visibleTree = useMemo(() => getReviewFileTreeVisibleState({
    tree,
    activePaths: activeFileFilter?.paths || null,
  }), [tree, activeFileFilter?.paths]);
  const searchedTree = useMemo(
    () => filterVisibleTreeBySearch(visibleTree, searchQuery),
    [visibleTree, searchQuery],
  );
  const searchedEntries = useMemo(
    () => [
      ...searchedTree.standaloneEntries,
      ...searchedTree.buckets.flatMap((bucket) => bucket.entries),
    ],
    [searchedTree],
  );
  const shouldUseFolderTree = tree.totalCount > SMART_FOLDER_TREE_THRESHOLD;
  const folderTree = useMemo(() => buildFolderTree(searchedEntries), [searchedEntries]);
  const filters = useMemo(
    () => [tree.filters.all, tree.filters.risky, tree.filters.code_only],
    [tree],
  );

  const isFilterActive = (filter: ReviewFileTreeFilter) => {
    if (filter.id === 'all') {
      return !activeFileFilter || !(activeFileFilter.paths || []).length;
    }
    if (activeFileFilter?.kind) {
      return activeFileFilter.kind === filter.id;
    }
    const activePaths = new Set((activeFileFilter?.paths || []).map((path) => String(path || '').trim()).filter(Boolean));
    if (activePaths.size === 0) return false;
    const filterPaths = new Set(filter.paths);
    if (activePaths.size !== filterPaths.size) return false;
    for (const path of activePaths) {
      if (!filterPaths.has(path)) return false;
    }
    return true;
  };

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-4)', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        Loading files…
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: 'var(--space-4)', fontSize: 11.5, color: 'var(--sev-high)' }}>
        {error}
      </div>
    );
  }
  if (tree.totalCount === 0) {
    return (
      <div style={{ padding: 'var(--space-4)', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        No changed files.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px 8px 6px', borderBottom: '1px solid var(--review-shell-divider)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 8 }}>
          {filters.map((filter) => {
            const active = isFilterActive(filter);
            return (
              <button
                key={filter.id}
                type="button"
                onClick={() => {
                  if (!onSelectFileFilter) return;
                  if (filter.id === 'all' || active) {
                    onSelectFileFilter(null);
                    return;
                  }
                  onSelectFileFilter({
                    label: filter.label,
                    paths: filter.paths,
                    kind: filter.id,
                  });
                }}
                style={{
                  ...getReviewSegmentButtonStyle({ active }),
                }}
              >
                {filter.label} ({filter.count})
              </button>
            );
          })}
        </div>
        <div style={{ position: 'relative' }}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 9,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-tertiary)',
              opacity: 0.75,
              pointerEvents: 'none',
            }}
          >
            <path
              d="M6.8 2.2a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Zm0 1.2a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm3.95 6.5 3.15 3.15-.85.85-3.15-3.15.85-.85Z"
              fill="currentColor"
            />
          </svg>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search files..."
            aria-label="Search files"
            spellCheck={false}
            style={{
              width: '100%',
              height: 30,
              padding: searchQuery ? '0 30px 0 30px' : '0 10px 0 30px',
              borderRadius: 7,
              border: '1px solid var(--border-muted)',
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              fontSize: 12,
              fontFamily: 'var(--font-ui)',
              outline: 'none',
            }}
            onFocus={(event) => {
              event.currentTarget.style.borderColor = 'color-mix(in oklab, var(--accent-blue) 45%, var(--border-muted))';
            }}
            onBlur={(event) => {
              event.currentTarget.style.borderColor = 'var(--border-muted)';
            }}
          />
          {searchQuery ? (
            <button
              type="button"
              aria-label="Clear file search"
              onClick={() => setSearchQuery('')}
              style={{
                position: 'absolute',
                right: 6,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 20,
                height: 20,
                border: 0,
                borderRadius: 5,
                background: 'transparent',
                color: 'var(--text-tertiary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                padding: 0,
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--bg-hover)';
                event.currentTarget.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = 'transparent';
                event.currentTarget.style.color = 'var(--text-tertiary)';
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="m4.15 3.3 3.85 3.85 3.85-3.85.85.85L8.85 8l3.85 3.85-.85.85L8 8.85 4.15 12.7l-.85-.85L7.15 8 3.3 4.15l.85-.85Z"
                  fill="currentColor"
                />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {searchedTree.totalVisibleCount === 0 ? (
        <div style={{ padding: 'var(--space-4)', fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {searchQuery.trim() ? 'No files match your search.' : 'No files match the current filter.'}
        </div>
      ) : (
        <>
          {shouldUseFolderTree ? (
            <FolderTreeView
              tree={folderTree}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          ) : (
            <div style={{ padding: '6px 0 10px' }}>
              {searchedEntries.map((entry) => (
                <FileEntryRow
                  key={entry.path}
                  entry={entry}
                  selectedPath={selectedPath}
                  onSelectFile={onSelectFile}
                />
              ))}
            </div>
          )}
        </>
      )}

      {summary && summary.hiddenCount > 0 && onLoadMoreFiles && (
        <ShowMoreFilesFooter
          summary={summary}
          incrementBy={Math.min(50, summary.hiddenCount)}
          loading={loadingMore}
          onClick={() => onLoadMoreFiles(summary.visibleCount)}
        />
      )}
    </div>
  );
}

function ShowMoreFilesFooter({
  summary,
  incrementBy,
  loading,
  onClick,
}: {
  summary: FileTreeManifestSummary;
  incrementBy: number;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        padding: '8px 10px',
        background: 'var(--bg-surface)',
        borderTop: '1px solid var(--review-shell-divider)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.3 }}>
        Showing {summary.visibleCount.toLocaleString()} of {summary.totalCount.toLocaleString()} files
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          width: '100%',
          height: 28,
          padding: '0 10px',
          borderRadius: 6,
          border: '1px solid var(--border-muted)',
          background: loading ? 'var(--bg-surface)' : 'transparent',
          color: loading ? 'var(--text-tertiary)' : 'var(--accent-blue)',
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          fontWeight: 600,
          cursor: loading ? 'default' : 'pointer',
        }}
        onMouseEnter={(e) => {
          if (!loading) {
            e.currentTarget.style.background = 'color-mix(in srgb, var(--accent-blue) 12%, transparent)';
            e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--accent-blue) 35%, var(--border-muted))';
          }
        }}
        onMouseLeave={(e) => {
          if (!loading) {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = 'var(--border-muted)';
          }
        }}
      >
        {loading ? 'Loading…' : `Show ${incrementBy} more files`}
      </button>
    </div>
  );
}

interface FolderTreeModel {
  nodes: FolderNode[];
  files: ReviewFileTreeEntry[];
}

interface FolderNode {
  name: string;
  path: string;
  children: Map<string, FolderNode>;
  files: ReviewFileTreeEntry[];
  count: number;
}

function buildFolderTree(entries: ReviewFileTreeEntry[]): FolderTreeModel {
  const root: FolderNode = { name: '', path: '', children: new Map(), files: [], count: 0 };
  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean);
    const fileName = parts.pop() || entry.fileName || entry.path;
    let current = root;
    current.count += 1;
    for (const part of parts) {
      const childPath = current.path ? `${current.path}/${part}` : part;
      let child = current.children.get(part);
      if (!child) {
        child = { name: part, path: childPath, children: new Map(), files: [], count: 0 };
        current.children.set(part, child);
      }
      child.count += 1;
      current = child;
    }
    current.files.push({ ...entry, fileName });
  }
  return {
    nodes: Array.from(root.children.values()),
    files: [...root.files],
  };
}

function FolderTreeView({
  tree,
  selectedPath,
  onSelectFile,
}: {
  tree: FolderTreeModel;
  selectedPath: string | null;
  onSelectFile?: (path: string) => void;
}) {
  if (tree.nodes.length === 0 && tree.files.length === 0) return null;
  return (
    <div style={{ padding: '6px 0 10px' }}>
      {tree.nodes.map((node) => (
        <FolderNodeRow
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
        />
      ))}
      {tree.files.map((entry) => (
        <FolderFileRow
          key={entry.path}
          entry={entry}
          depth={0}
          selected={selectedPath === entry.path}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}

function FolderNodeRow({
  node,
  depth,
  selectedPath,
  onSelectFile,
}: {
  node: FolderNode;
  depth: number;
  selectedPath: string | null;
  onSelectFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const childNodes = useMemo(() => Array.from(node.children.values()), [node.children]);
  const files = useMemo(() => [...node.files], [node.files]);

  useEffect(() => {
    if (containsPath(node, selectedPath)) setExpanded(true);
  }, [node, selectedPath]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          width: '100%',
          minHeight: 28,
          padding: `0 10px 0 ${10 + depth * 14}px`,
          border: 0,
          background: 'transparent',
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          cursor: 'pointer',
          fontFamily: 'var(--font-ui)',
          fontSize: 11.5,
          textAlign: 'left',
        }}
      >
        <span style={{ width: 10, color: 'var(--text-tertiary)', fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
        <FolderIcon />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name}
        </span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
          {node.count}
        </span>
      </button>
      {expanded && (
        <div>
          {childNodes.map((child) => (
            <FolderNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
            />
          ))}
          {files.map((entry) => (
            <FolderFileRow
              key={entry.path}
              entry={entry}
              depth={depth + 1}
              selected={selectedPath === entry.path}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderFileRow({
  entry,
  depth,
  selected,
  onSelectFile,
}: {
  entry: ReviewFileTreeEntry;
  depth: number;
  selected: boolean;
  onSelectFile?: (path: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectFile?.(entry.path)}
      title={entry.path}
      style={{
        width: '100%',
        minHeight: 30,
        padding: `0 10px 0 ${24 + depth * 14}px`,
        border: 0,
        borderLeft: selected ? '2px solid var(--accent-blue)' : '2px solid transparent',
        background: selected ? 'var(--review-card-hover)' : 'transparent',
        color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        cursor: 'pointer',
        fontFamily: 'var(--font-ui)',
        textAlign: 'left',
      }}
    >
      <FileIcon status={entry.status} />
      <span style={{
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 11.5,
        fontWeight: selected ? 700 : 500,
      }}>
        {entry.fileName}
      </span>
      <span style={{ display: 'flex', gap: 5, fontSize: 10, fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
        {entry.additions > 0 && <span style={{ color: 'var(--accent-green)' }}>+{entry.additions}</span>}
        {entry.deletions > 0 && <span style={{ color: 'var(--accent-red)' }}>-{entry.deletions}</span>}
      </span>
    </button>
  );
}

function containsPath(node: FolderNode, selectedPath: string | null): boolean {
  return Boolean(selectedPath && (selectedPath === node.path || selectedPath.startsWith(`${node.path}/`)));
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>
      <path d="M1.5 4.2c0-.72.58-1.3 1.3-1.3h3.1l1.2 1.3h6.1c.72 0 1.3.58 1.3 1.3v6.3c0 .72-.58 1.3-1.3 1.3H2.8c-.72 0-1.3-.58-1.3-1.3V4.2Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FileIcon({ status }: { status?: string | null }) {
  const normalized = String(status || '').toUpperCase();
  const color = normalized.startsWith('A')
    ? 'var(--accent-green)'
    : normalized.startsWith('D')
      ? 'var(--accent-red)'
      : 'var(--text-tertiary)';
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ color, flexShrink: 0 }}>
      <path d="M3.5 1.8h5.2l3.8 3.8v8.6H3.5V1.8Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8.7 1.9v3.7h3.7" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function filterVisibleTreeBySearch(tree: ReviewFileTreeVisibleState, query: string): ReviewFileTreeVisibleState {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return tree;

  const matchesEntry = (entry: ReviewFileTreeEntry) => (
    entry.path.toLowerCase().includes(normalizedQuery)
    || entry.fileName.toLowerCase().includes(normalizedQuery)
    || (entry.directory || '').toLowerCase().includes(normalizedQuery)
    || (entry.oldPath || '').toLowerCase().includes(normalizedQuery)
  );

  const standaloneEntries = tree.standaloneEntries.filter(matchesEntry);
  const buckets = tree.buckets
    .map((bucket) => ({
      ...bucket,
      entries: bucket.entries.filter(matchesEntry),
    }))
    .filter((bucket) => bucket.entries.length > 0);

  return {
    standaloneEntries,
    buckets,
    totalVisibleCount: standaloneEntries.length + buckets.reduce((sum, bucket) => sum + bucket.entries.length, 0),
  };
}

function FileEntryRow({
  entry,
  selectedPath,
  onSelectFile,
}: {
  entry: ReviewFileTreeEntry;
  selectedPath: string | null;
  onSelectFile?: (path: string) => void;
}) {
  return (
    <FileRow
      path={entry.path}
      sev={toSevLevel(entry.highestFindingSeverity)}
      adds={entry.additions}
      dels={entry.deletions}
      active={selectedPath === entry.path}
      dense
      onClick={() => onSelectFile?.(entry.path)}
    />
  );
}

function toSevLevel(severity: RiskLevel | null): 'HIGH' | 'MED' | 'LOW' | undefined {
  if (severity === 'critical' || severity === 'high') return 'HIGH';
  if (severity === 'medium') return 'MED';
  if (severity === 'low') return 'LOW';
  return undefined;
}

async function fetchFileTreeData(opts: {
  projectId: string;
  branchReviewId?: string;
  workspaceReviewId?: string;
  prReviewId?: string;
  visibleFileLimit?: number;
}): Promise<FileTreeData> {
  const { projectId, branchReviewId, workspaceReviewId, prReviewId, visibleFileLimit } = opts;
  const apiOptions = visibleFileLimit ? { visibleFileLimit } : undefined;
  if (branchReviewId) {
    const res = await branchReviewApi.get(projectId, branchReviewId, apiOptions);
    return {
      files: (res.branchReview?.files || []).map(toSummary),
      review: parseReviewJson((res.branchReview as { reviewJson?: unknown })?.reviewJson),
      summary: extractManifestSummary((res.branchReview as { diffManifestSummary?: unknown })?.diffManifestSummary),
    };
  }
  if (prReviewId) {
    const res = await prReviewApi.get(projectId, prReviewId, apiOptions);
    return {
      files: (res.files || []).map(toSummary),
      review: parseReviewJson(res.prReview?.reviewJson),
      summary: extractManifestSummary((res.prReview as { diffManifestSummary?: unknown })?.diffManifestSummary),
    };
  }
  if (workspaceReviewId) {
    const res = await workspaceReviewApi.get(projectId, workspaceReviewId, apiOptions);
    return {
      files: ((res.workspaceReview as { files?: BranchReviewFileSummary[] })?.files || []).map(toSummary),
      review: parseReviewJson((res.workspaceReview as { reviewJson?: unknown })?.reviewJson),
      summary: extractManifestSummary((res.workspaceReview as { diffManifestSummary?: unknown })?.diffManifestSummary),
    };
  }
  return { files: [], review: null, summary: null };
}

function extractManifestSummary(value: unknown): FileTreeManifestSummary | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const visibleCount = Number(v.visibleCount);
  const totalCount = Number(v.totalCount);
  if (!Number.isFinite(visibleCount) || !Number.isFinite(totalCount)) return null;
  const hiddenCount = Number.isFinite(Number(v.hiddenCount)) ? Number(v.hiddenCount) : Math.max(0, totalCount - visibleCount);
  return {
    visibleCount: Math.max(0, visibleCount),
    totalCount: Math.max(0, totalCount),
    hiddenCount: Math.max(0, hiddenCount),
    isCapped: Boolean(v.isCapped) || hiddenCount > 0,
  };
}

function toSummary(f: { path: string; additions?: number; deletions?: number; status?: string; oldPath?: string | null }): BranchReviewFileSummary {
  return {
    path: f.path,
    additions: Number(f.additions || 0),
    deletions: Number(f.deletions || 0),
    status: f.status || 'M',
    oldPath: f.oldPath ?? null,
  };
}

function parseReviewJson(value: unknown): ReviewResult | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as ReviewResult;
    } catch {
      return null;
    }
  }
  return value as ReviewResult;
}
