/**
 * SummaryDiffView — Scrollable summary view for the center diff panel.
 * Shows a review summary card at top, followed by all changed files in a
 * collapsible list with full unified diffs (syntax highlighted, context collapsed).
 */

import { useState, useMemo, useCallback, useRef, useImperativeHandle, forwardRef, useEffect, useLayoutEffect, useContext, createContext } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import toast from '@/lib/toast';
import { computeUnifiedDiff, parseUnifiedPatchToDiffLines, collapseContext } from '@/utils/diff';
import type { DiffLine, DiffLineOrCollapsed, CollapsedSection } from '@/utils/diff';
import { useSyntaxTokens } from '@/hooks/useSyntaxTokens';
import {
  getRecommendationPatchLine,
  getRecommendationSourceFile,
  getRecommendationSourceLine,
  resolveRecommendationDisplayAnchor,
  resolveRenderedLineTarget,
  type RecommendationDisplayAnchorMode,
} from '@/utils/reviewNavigation';
import { isCollapsedSection, UnifiedDiffLine, SplitDiffLine, CollapsedBar } from '@/components/review/DiffPrimitives';
import type { SplitRow } from '@/components/review/DiffPrimitives';
import { InlineCommentCard, InlineComments, useCommentsByLine } from '@/components/review/InlineComments';
import { ManualLineCommentAuthor } from '@/components/review/ManualLineCommentAuthor';
import {
  formatGitHubConversationExactTime,
  formatGitHubConversationTime,
  getGitHubConversationDiffTarget,
} from '@/components/review/GitHubConversation';
import { GitHubConversationComment } from '@/components/review/GitHubConversationsSection';
import { buildReviewPathLookup, resolveCanonicalReviewPath } from '@/utils/reviewPathMatching';
import { AtlasAiMark } from './AtlasAiMark';
import { resolveAtlasDiffSelection, type AtlasDiffSelection } from './atlasDiffSelection';

import type { GitHubPrReviewThread, GitHubPrThreadComment, ReviewChangeGroup, ReviewFileFilter, ReviewRecommendation, ReviewResult } from '@/types';
import type { ReviewAgentAttachment } from '@/services/reviewAgentApi';
import {
  RISK_BG_COLORS,
  RISK_COLORS,
  flattenReviewFileTreeEntriesByFolder,
  getReviewFileTreeVisibleState,
  getRecommendationResolutionFor,
  type ReviewFileTreeBucket,
  type ReviewFileTreeEntry,
  type ReviewFileTreeFilter,
  type ReviewFileTreeModel,
  type RecommendationResolutionMap,
} from './reviewPanelUtils';
import {
  ReviewActionButton,
  getReviewCardStyle,
  getReviewSegmentButtonStyle,
  reviewSurfaceStyle,
} from './ReviewChrome';

const FILE_SCROLL_MARGIN_TOP_PX = 128;
const FINDING_SCOPED_CONTEXT_ROWS = 24;
const FINDING_INLINE_COMMENT_MIN_PRECEDING_ROWS = 8;
// Cap how many diff rows a single huge file mounts up-front. Files like
// auto-generated Unity scripts can produce thousands of visible rows even
// after context collapse — and that DOM volume is what jams scroll on
// WKWebView. Past this cap we render a "Show remaining N lines" button.
const HUGE_FILE_RENDER_CAP = 500;

// Per-file callback registry: each ExpandedFileDiff registers an
// `ensureLineRendered(line, side)` function under its file path. Navigation
// (scrollToFileInternal, finding-anchor jumps, GitHub conversation jumps)
// looks up the registry by target path and invokes it before retrying the
// DOM scroll. If the requested line falls past HUGE_FILE_RENDER_CAP, the
// callback flips renderAllLines so the line is mounted before the retry.
type LineExpander = (line: number, side?: 'LEFT' | 'RIGHT' | null) => void;
type LineExpanderRegistry = Map<string, LineExpander>;
const LineExpanderRegistryContext = createContext<LineExpanderRegistry | null>(null);

// ── Props ──────────────────────────────────────────────────────────────

export interface SummaryFileEntry {
  path: string;
  before: string | null;
  after: string | null;
  status?: string;       // 'A' | 'M' | 'D' | 'R'
  additions?: number;
  deletions?: number;
  patch?: string | null;
  contentLoaded?: boolean;
  contentLoading?: boolean;
}

export interface ReviewSummaryData {
  summary: string;
  riskLevel: string;
  changeGroups: ReviewChangeGroup[];
  stats: ReviewResult['stats'];
}

export interface SummaryDiffViewProps {
  files: SummaryFileEntry[];
  fileStatsByPath: Map<string, { additions: number; deletions: number }>;
  fileTree: ReviewFileTreeModel;
  reviewSummary: ReviewSummaryData | null;
  isLoadingReview: boolean;
  viewMode?: 'unified' | 'split';
  fallbackSummary?: string | null;
  onRequestContent?: (paths: string[]) => void;
  recommendations?: ReviewRecommendation[];
  recommendationResolutions?: RecommendationResolutionMap;
  githubConversationThreads?: GitHubPrReviewThread[];
  githubConversationPrAuthorLogin?: string | null;
  githubConversationControls?: GitHubConversationInlineControls;
  canCommentOnRecommendation?: boolean;
  getRecommendationComment?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationComment?: (rec: ReviewRecommendation, comment: string) => void;
  onClearRecommendationComment?: (rec: ReviewRecommendation) => void;
  canAddRecommendationNotes?: boolean;
  getRecommendationNote?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationNote?: (rec: ReviewRecommendation, note: string) => void;
  onClearRecommendationNote?: (rec: ReviewRecommendation) => void;
  canCommentOnAnyLine?: boolean;
  commentingUnavailableReason?: string | null;
  getManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSaveManualLineComment?: (path: string, line: number, comment: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  canAddPrivateNotes?: boolean;
  getPrivateNote?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSavePrivateNote?: (path: string, line: number, note: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearPrivateNote?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  getFilePrivateNote?: (path: string) => string;
  onSaveFilePrivateNote?: (path: string, note: string) => void;
  onClearFilePrivateNote?: (path: string) => void;
  activeFileFilter?: ReviewFileFilter | null;
  onSelectFileFilter?: (filter: ReviewFileFilter | null) => void;
  onViewModeChange?: (mode: 'unified' | 'split') => void;
  presentationMode?: 'accordion' | 'files-feed';
  onActiveFileChange?: (path: string) => void;
  onFilesFeedViewportChange?: (paths: string[]) => void;
  onAskAtlasSelection?: (payload: {
    attachment: Extract<ReviewAgentAttachment, { type: 'line_range' }>;
    prompt: string;
  }) => void;
  onAskAtlasFinding?: (rec: ReviewRecommendation) => void;
  onAskAtlasFile?: (path: string) => void;
}

// ── Status config ──────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  A: { label: 'New file', color: 'var(--accent-green)', bg: 'var(--chip-success-bg)', icon: '+' },
  M: { label: 'Modified', color: 'var(--accent-yellow)', bg: 'var(--chip-warning-bg)', icon: '~' },
  D: { label: 'Deleted', color: 'var(--accent-red)', bg: 'var(--chip-error-bg)', icon: '-' },
  R: { label: 'Renamed', color: 'var(--accent-blue)', bg: 'var(--chip-info-bg)', icon: '>' },
};

function showNearestRenderedDiffToast(sourceLine?: number | null, renderedLine?: number | null) {
  toast.info('Showing the closest visible diff context', {
    id: 'review-nearest-rendered-diff-line',
    duration: 3200,
    description: sourceLine != null && renderedLine != null
      ? `Source line ${sourceLine} is not part of the visible diff, so the comment is shown near rendered line ${renderedLine}.`
      : 'The original source line sits outside the visible patch for this file, so the viewer snapped to the closest rendered line instead.',
  });
}

function resolveStatus(file: SummaryFileEntry): string {
  if (file.status) return file.status.charAt(0).toUpperCase();
  if (file.before === null) return 'A';
  if (file.after === null) return 'D';
  return 'M';
}

function makeGitHubConversationLineKey(lineNumber: number | null | undefined, side: 'LEFT' | 'RIGHT'): string | null {
  const normalized = Number.isFinite(Number(lineNumber)) && Number(lineNumber) > 0
    ? Math.floor(Number(lineNumber))
    : null;
  return normalized ? `${side}:${normalized}` : null;
}

function buildGitHubConversationsByLine(
  threads: GitHubPrReviewThread[] | undefined | null,
  filePath: string,
  canonicalPathLookup: Map<string, string>,
): Map<string, GitHubPrReviewThread[]> {
  if (!threads || threads.length === 0 || !filePath) return new Map();
  const canonicalFilePath = resolveCanonicalReviewPath(filePath, canonicalPathLookup) || filePath;
  const map = new Map<string, GitHubPrReviewThread[]>();
  for (const thread of threads) {
    const target = getGitHubConversationDiffTarget(thread);
    if (!target?.path || !target.line) continue;
    const canonicalThreadPath = resolveCanonicalReviewPath(target.path, canonicalPathLookup) || target.path;
    if (canonicalThreadPath !== canonicalFilePath) continue;
    const key = makeGitHubConversationLineKey(target.line, target.side);
    if (!key) continue;
    const existing = map.get(key) || [];
    existing.push(thread);
    map.set(key, existing);
  }
  return map;
}

function isFileSplittable(file: SummaryFileEntry): boolean {
  const status = resolveStatus(file);
  if (status === 'A' || status === 'D') return false;
  return file.before !== null && file.after !== null;
}

function getDiffLineFocusNumber(line: DiffLine): number | null {
  const raw = line.newNum ?? line.oldNum;
  return Number.isFinite(Number(raw)) && Number(raw) > 0
    ? Math.floor(Number(raw))
    : null;
}

function collapseAroundFocusLine(
  lines: DiffLine[],
  focusLine: number | null | undefined,
  contextRows: number = FINDING_SCOPED_CONTEXT_ROWS,
): DiffLineOrCollapsed[] {
  if (lines.length === 0) return [];
  const focus = Number.isFinite(Number(focusLine)) && Number(focusLine) > 0
    ? Math.floor(Number(focusLine))
    : null;
  if (focus == null) return collapseContext(lines, 3);

  const visible = new Uint8Array(lines.length);
  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = getDiffLineFocusNumber(lines[i]);
    if (lineNumber == null) continue;
    const distance = Math.abs(lineNumber - focus);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }

  if (nearestIndex < 0) return collapseContext(lines, 3);

  // Use rendered diff row distance, not source line distance. Large rewrites
  // can jump hundreds of old/new line numbers inside one patch, so line-number
  // windows tend to leave too much visible below the finding.
  for (let offset = -contextRows; offset <= contextRows; offset++) {
    const idx = nearestIndex + offset;
    if (idx >= 0 && idx < lines.length) visible[idx] = 1;
  }

  const result: DiffLineOrCollapsed[] = [];
  let i = 0;
  while (i < lines.length) {
    if (visible[i]) {
      result.push(lines[i]);
      i++;
      continue;
    }

    const start = i;
    while (i < lines.length && !visible[i]) i++;
    const count = i - start;
    if (count > 1) {
      result.push({ type: 'collapsed', count, startIdx: start, endIdx: i });
    } else {
      for (let j = start; j < i; j++) result.push(lines[j]);
    }
  }

  return result;
}

type InlineCommentEntry = {
  rec: ReviewRecommendation;
  mode: RecommendationDisplayAnchorMode;
  sourceLine: number | null;
};

function ensureInlineCommentPrecedingContext(
  commentsByLine: Map<number, InlineCommentEntry[]>,
  displayLines: DiffLineOrCollapsed[],
  minRowsBefore: number = FINDING_INLINE_COMMENT_MIN_PRECEDING_ROWS,
): Map<number, InlineCommentEntry[]> {
  if (commentsByLine.size === 0 || minRowsBefore <= 0) return commentsByLine;

  const next = new Map(commentsByLine);
  const movedSourceLines = new Set<number>();
  const processSegment = (segment: Array<{ lineNumber: number }>) => {
    if (segment.length <= 1) return;

    segment.forEach((entry, index) => {
      if (movedSourceLines.has(entry.lineNumber)) return;
      const comments = commentsByLine.get(entry.lineNumber);
      if (!comments || comments.length === 0 || index >= minRowsBefore) return;

      const target = segment[Math.min(segment.length - 1, minRowsBefore)];
      if (!target || target.lineNumber === entry.lineNumber) return;

      movedSourceLines.add(entry.lineNumber);
      next.delete(entry.lineNumber);
      next.set(target.lineNumber, [
        ...(next.get(target.lineNumber) || []),
        ...comments,
      ]);
    });
  };

  let segment: Array<{ lineNumber: number }> = [];
  for (const item of displayLines) {
    if (isCollapsedSection(item)) {
      processSegment(segment);
      segment = [];
      continue;
    }

    const lineNumber = getDiffLineFocusNumber(item as DiffLine);
    if (lineNumber != null) segment.push({ lineNumber });
  }
  processSegment(segment);

  return next;
}

function resolveFindingFocusLine(
  activeFileFilter: ReviewFileFilter | null | undefined,
  recommendations: ReviewRecommendation[] | undefined,
): number | null {
  const explicitFocus = Number(activeFileFilter?.focusLine);
  if (Number.isFinite(explicitFocus) && explicitFocus > 0) {
    return Math.floor(explicitFocus);
  }

  if (activeFileFilter?.kind !== 'finding') return null;
  const filterPaths = new Set(
    (activeFileFilter.paths || [])
      .map((path) => String(path || '').trim())
      .filter(Boolean)
  );
  if (filterPaths.size === 0) return null;

  const label = String(activeFileFilter.label || '').trim();
  const candidates = (recommendations || []).filter((rec) => {
    if (!rec || (rec.type !== 'issue' && rec.type !== 'suggestion')) return false;
    const file = getRecommendationSourceFile(rec);
    if (!filterPaths.has(file)) return false;
    return !label || rec.title === label || file === label;
  });
  const target = candidates[0] || (recommendations || []).find((rec) => (
    rec
    && (rec.type === 'issue' || rec.type === 'suggestion')
    && filterPaths.has(getRecommendationSourceFile(rec))
  ));
  if (!target) return null;
  return getRecommendationPatchLine(target) ?? getRecommendationSourceLine(target);
}

// ── Ref type ────────────────────────────────────────────────────────────

export interface SummaryDiffViewRef {
  scrollToFile: (filePath: string, line?: number, options?: { side?: 'LEFT' | 'RIGHT' | null; suppressNearestDiffToast?: boolean }) => boolean;
  navigateHunk: (direction: 'next' | 'prev') => boolean;
  navigateComment: (direction: 'next' | 'prev') => boolean;
}

export interface GitHubConversationInlineControls {
  onReplyThread?: (thread: GitHubPrReviewThread, body: string) => Promise<void>;
  onSetThreadResolved?: (thread: GitHubPrReviewThread, resolved: boolean) => Promise<void>;
  onUpdateComment?: (comment: GitHubPrThreadComment, body: string) => Promise<void>;
  onDeleteComment?: (comment: GitHubPrThreadComment) => Promise<void>;
  onConfirmDeleteComment?: (comment: GitHubPrThreadComment) => Promise<boolean>;
  onAskAgent?: (thread: GitHubPrReviewThread) => void;
  busyThreadId?: string | null;
  busyCommentId?: string | null;
}

type HunkNavigationTarget = { path: string; line: number; key: string };
function getHunkNavigationTargetKey(path: string, line: number): string {
  return `${path}\u0000${line}`;
}

// ── Main Component ─────────────────────────────────────────────────────

export const SummaryDiffView = forwardRef<SummaryDiffViewRef, SummaryDiffViewProps>(function SummaryDiffView({
  files,
  fileStatsByPath,
  fileTree,
  reviewSummary: _,
  isLoadingReview: __,
  viewMode = 'unified',
  fallbackSummary: ___,
  onRequestContent,
  recommendations,
  recommendationResolutions = {},
  githubConversationThreads = [],
  githubConversationPrAuthorLogin = null,
  githubConversationControls,
  canCommentOnRecommendation = false,
  getRecommendationComment,
  onSaveRecommendationComment,
  onClearRecommendationComment,
  canAddRecommendationNotes = false,
  getRecommendationNote,
  onSaveRecommendationNote,
  onClearRecommendationNote,
  canCommentOnAnyLine = false,
  commentingUnavailableReason = null,
  getManualLineComment,
  onSaveManualLineComment,
  onClearManualLineComment,
  canAddPrivateNotes = false,
  getPrivateNote,
  onSavePrivateNote,
  onClearPrivateNote,
  getFilePrivateNote,
  onSaveFilePrivateNote,
  onClearFilePrivateNote,
  activeFileFilter = null,
  onSelectFileFilter,
  onViewModeChange,
  presentationMode = 'accordion',
  onActiveFileChange,
  onFilesFeedViewportChange,
  onAskAtlasSelection,
  onAskAtlasFinding,
  onAskAtlasFile,
}, ref) {
  const [expandState, setExpandState] = useState<Record<string, boolean>>({});
  const [bucketExpandState, setBucketExpandState] = useState<Record<string, boolean>>({});
  const [allExpanded, setAllExpanded] = useState(false);
  const [atlasDiffSelection, setAtlasDiffSelection] = useState<AtlasDiffSelection | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Registry of per-file "ensure this line is rendered" callbacks (see
  // LineExpanderRegistryContext). scrollToFileInternal calls into this so a
  // navigation target past the huge-file render cap can mount its line
  // before the DOM-scroll retry loop runs.
  const lineExpanderRegistryRef = useRef<LineExpanderRegistry>(new Map());
  const hunkAnchorIndexRef = useRef<number | null>(null);
  const hunkAnchorTargetKeyRef = useRef<string | null>(null);
  const commentAnchorIndexRef = useRef<number | null>(null);
  const filesFeedResetKeyRef = useRef<string | null>(null);
  const filesFeedActivePathRef = useRef<string | null>(null);
  const filesFeedViewportPathsRef = useRef<Set<string>>(new Set());
  const filesFeedViewportRafRef = useRef<number | null>(null);
  // Sticky set of file paths that have entered the viewport at least once.
  // Used to gate Shiki tokenization in feed mode so a 200+ file PR doesn't
  // tokenize everything up front. Once a path is in here it stays — tokens
  // are cached in syntaxHighlight.ts, so re-scrolling never re-tokenizes.
  const [tokenizableFilePaths, setTokenizableFilePaths] = useState<Set<string>>(() => new Set());
  const tokenizablePendingRef = useRef<Set<string>>(new Set());
  const tokenizableRafRef = useRef<number | null>(null);
  const tokenizableFilePathsRef = useRef<Set<string>>(tokenizableFilePaths);
  tokenizableFilePathsRef.current = tokenizableFilePaths;
  // Virtuoso integration for the feed view: only mounts cards near the
  // viewport, dropping the React tree from 200+ rows to ~10. Avoids the
  // content-visibility paint stutter on WKWebView.
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [virtuosoScrollParent, setVirtuosoScrollParent] = useState<HTMLElement | null>(null);
  const fileByPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const visibleTree = useMemo(() => (
    getReviewFileTreeVisibleState({
      tree: fileTree,
      activePaths: activeFileFilter?.paths || null,
    })
  ), [fileTree, activeFileFilter?.paths]);
  const visibleEntries = useMemo(
    () => [
      ...visibleTree.standaloneEntries,
      ...visibleTree.buckets.flatMap((bucket) => bucket.entries),
    ],
    [visibleTree]
  );
  const filters = useMemo(
    () => [fileTree.filters.all, fileTree.filters.risky, fileTree.filters.code_only],
    [fileTree]
  );
  const isFindingScopedDiff = activeFileFilter?.kind === 'finding';
  const isLineScopedDiff = activeFileFilter?.kind === 'finding' || activeFileFilter?.kind === 'github_conversation';
  const isFilesFeed = presentationMode === 'files-feed' && !isLineScopedDiff;
  const feedEntries = useMemo(
    () => (isFilesFeed ? flattenReviewFileTreeEntriesByFolder(visibleEntries) : visibleEntries),
    [isFilesFeed, visibleEntries],
  );
  const findingFocusLine = useMemo(
    () => (isLineScopedDiff ? resolveFindingFocusLine(activeFileFilter, recommendations) : null),
    [activeFileFilter, isLineScopedDiff, recommendations]
  );
  const hunkTargets = useMemo(() => (
    feedEntries.flatMap((entry) => {
      const file = fileByPath.get(entry.path);
      if (!file) return [];
      const diffLines = typeof file.patch === 'string' && file.patch.trim()
        ? parseUnifiedPatchToDiffLines(file.patch)
        : computeUnifiedDiff(file.before, file.after);
      const targets: HunkNavigationTarget[] = [];
      let previousType: DiffLine['type'] | null = null;
      for (const line of diffLines) {
        if (line.type === 'context') {
          previousType = 'context';
          continue;
        }
        if (previousType === null || previousType === 'context') {
          const anchorLine = Number.isFinite(Number(line.newNum)) && Number(line.newNum) > 0
            ? Math.floor(Number(line.newNum))
            : (Number.isFinite(Number(line.oldNum)) && Number(line.oldNum) > 0
                ? Math.floor(Number(line.oldNum))
                : null);
          if (anchorLine != null) {
            targets.push({
              path: entry.path,
              line: anchorLine,
              key: getHunkNavigationTargetKey(entry.path, anchorLine),
            });
          }
        }
        previousType = line.type;
      }
      return targets;
    })
  ), [feedEntries, fileByPath]);
  const entryByPath = useMemo(
    () => new Map(feedEntries.map((entry) => [entry.path, entry])),
    [feedEntries]
  );
  const feedFiles = useMemo(
    () => feedEntries
      .map((entry) => fileByPath.get(entry.path))
      .filter((file): file is SummaryFileEntry => Boolean(file)),
    [feedEntries, fileByPath]
  );
  const feedFilePaths = useMemo(
    () => feedEntries.map((entry) => entry.path),
    [feedEntries]
  );
  const filesFeedResetKey = useMemo(() => (
    isFilesFeed
      ? [
          activeFileFilter?.kind || 'all',
          (activeFileFilter?.paths || []).join('\0'),
          feedFilePaths[0] || '',
          feedFilePaths.length,
        ].join('|')
      : ''
  ), [activeFileFilter?.kind, activeFileFilter?.paths, feedFilePaths, isFilesFeed]);

  const isFilterActive = useCallback((filter: ReviewFileTreeFilter) => {
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
  }, [activeFileFilter]);

  useEffect(() => {
    if (isFilesFeed || activeFileFilter?.kind !== 'finding') return;
    const targetPath = (activeFileFilter.paths || [])[0];
    if (!targetPath) return;

    const matchedFile = files.find((file) => (
      file.path === targetPath
      || (typeof (file as SummaryFileEntry & { oldPath?: string | null }).oldPath === 'string'
        && (file as SummaryFileEntry & { oldPath?: string | null }).oldPath === targetPath)
    ));
    if (!matchedFile) return;

    const resolvedPath = matchedFile.path;
    const bucketContainingFile = visibleTree.buckets.find((bucket) => (
      bucket.entries.some((entry) => entry.path === resolvedPath)
    ));

    if (bucketContainingFile) {
      setBucketExpandState((prev) => (
        prev[bucketContainingFile.id] === true
          ? prev
          : { ...prev, [bucketContainingFile.id]: true }
      ));
    }

    setExpandState((prev) => (
      prev[resolvedPath] === true ? prev : { ...prev, [resolvedPath]: true }
    ));

    if (onRequestContent && matchedFile.contentLoaded === false && !matchedFile.contentLoading) {
      onRequestContent([resolvedPath]);
    }
  }, [activeFileFilter, files, isFilesFeed, onRequestContent, visibleTree.buckets]);

  const toggleFile = useCallback((path: string) => {
    setExpandState(prev => {
      const expanding = !prev[path];
      return { ...prev, [path]: expanding };
    });
  }, []);

  // Trigger content loading when a file is expanded but content not yet loaded
  const handleToggle = useCallback((path: string) => {
    const wasExpanded = expandState[path] ?? false;
    toggleFile(path);
    if (!wasExpanded && onRequestContent) {
      const file = files.find(f => f.path === path);
      if (file && file.contentLoaded === false && !file.contentLoading) {
        onRequestContent([path]);
      }
    }
  }, [expandState, toggleFile, onRequestContent, files]);

  const toggleAll = useCallback(() => {
    const next = !allExpanded;
    setAllExpanded(next);
    const state: Record<string, boolean> = {};
    for (const entry of visibleEntries) {
      state[entry.path] = next;
    }
    setExpandState(state);
    const nextBucketState: Record<string, boolean> = {};
    for (const bucket of visibleTree.buckets) {
      nextBucketState[bucket.id] = next;
    }
    setBucketExpandState(prev => ({ ...prev, ...nextBucketState }));
    if (next && onRequestContent) {
      const needContent = visibleEntries
        .map((entry) => fileByPath.get(entry.path))
        .filter((file): file is SummaryFileEntry => Boolean(file))
        .filter(f => f.contentLoaded === false && !f.contentLoading)
        .map(f => f.path);
      if (needContent.length > 0) {
        onRequestContent(needContent);
      }
    }
  }, [allExpanded, visibleEntries, visibleTree.buckets, onRequestContent, fileByPath]);

  const isFileExpanded = useCallback((path: string) => {
    return expandState[path] ?? false;
  }, [expandState]);

  const updateActiveFileFromScroll = useCallback(() => {
    if (!isFilesFeed || !onActiveFileChange) return;
    const container = containerRef.current;
    if (!container) return;
    const sections = Array.from(container.querySelectorAll('[data-file-path]'))
      .filter((element): element is HTMLElement => element instanceof HTMLElement);
    if (sections.length === 0) return;

    const publishActivePath = (path: string) => {
      if (!path || filesFeedActivePathRef.current === path) return;
      filesFeedActivePathRef.current = path;
      onActiveFileChange(path);
    };

    if (container.scrollTop <= 8) {
      const firstPath = feedFilePaths[0]
        || sections[0]?.getAttribute('data-file-path')
        || '';
      publishActivePath(firstPath);
      return;
    }

    const hasScrollableOverflow = container.scrollHeight > container.clientHeight + 8;
    if (hasScrollableOverflow && container.scrollHeight - container.scrollTop - container.clientHeight <= 8) {
      const lastPath = feedFilePaths[feedFilePaths.length - 1]
        || sections[sections.length - 1]?.getAttribute('data-file-path')
        || '';
      publishActivePath(lastPath);
      return;
    }

    const threshold = container.getBoundingClientRect().top + FILE_SCROLL_MARGIN_TOP_PX + 24;
    const currentPath = filesFeedActivePathRef.current;
    if (currentPath) {
      const currentSection = sections.find((section) => section.getAttribute('data-file-path') === currentPath);
      if (currentSection) {
        const rect = currentSection.getBoundingClientRect();
        if (rect.top <= threshold && rect.bottom > threshold) {
          return;
        }
      }
    }

    let active = sections[0];
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= threshold) {
        active = section;
      } else {
        break;
      }
    }
    const path = active.getAttribute('data-file-path');
    if (path) publishActivePath(path);
  }, [feedFilePaths, isFilesFeed, onActiveFileChange]);

  const updateAtlasDiffSelection = useCallback(() => {
    if (!onAskAtlasSelection) return;
    setAtlasDiffSelection(resolveAtlasDiffSelection(containerRef.current));
  }, [onAskAtlasSelection]);

  const handleSummaryScroll = useCallback(() => {
    updateActiveFileFromScroll();
    if (atlasDiffSelection) setAtlasDiffSelection(null);
  }, [atlasDiffSelection, updateActiveFileFromScroll]);

  const handleAskAtlasSelection = useCallback(() => {
    if (!atlasDiffSelection) return;
    onAskAtlasSelection?.({
      attachment: atlasDiffSelection.attachment,
      prompt: atlasDiffSelection.prompt,
    });
    setAtlasDiffSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [atlasDiffSelection, onAskAtlasSelection]);

  const flashLineElement = useCallback((lineEl: Element) => {
    const el = lineEl as HTMLElement;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.transition = 'background 0.3s ease, box-shadow 0.3s ease, border-left-color 0.3s ease';
    el.style.background = 'var(--review-line-jump-bg)';
    el.style.boxShadow = 'inset 0 0 0 1px var(--review-line-jump-border), inset 0 0 0 999px var(--review-line-jump-glow)';
    el.style.borderLeftColor = 'var(--accent-blue)';
    setTimeout(() => {
      el.style.background = '';
      el.style.boxShadow = '';
      el.style.borderLeftColor = '';
    }, 4000);
  }, []);

  const flashNavigationAnchor = useCallback((anchorEl: HTMLElement) => {
    anchorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    anchorEl.style.transition = 'box-shadow 0.25s ease, outline-color 0.25s ease, background 0.25s ease';
    anchorEl.style.outline = '1px solid rgba(88, 166, 255, 0.72)';
    anchorEl.style.outlineOffset = '2px';
    anchorEl.style.boxShadow = '0 0 0 1px rgba(88, 166, 255, 0.22), 0 0 26px rgba(88, 166, 255, 0.18)';
    anchorEl.style.background = 'color-mix(in srgb, var(--review-line-jump-bg) 50%, transparent)';
    window.setTimeout(() => {
      anchorEl.style.outline = '';
      anchorEl.style.outlineOffset = '';
      anchorEl.style.boxShadow = '';
      anchorEl.style.background = '';
    }, 2200);
  }, []);

  const navigateAnchors = useCallback((
    selector: string,
    direction: 'next' | 'prev',
    indexRef: { current: number | null },
  ): boolean => {
    const container = containerRef.current;
    if (!container) return false;
    const anchors = Array.from(container.querySelectorAll(selector))
      .filter((element): element is HTMLElement => element instanceof HTMLElement);
    if (anchors.length === 0) return false;

    let nextIndex = 0;
    if (indexRef.current != null && indexRef.current >= 0 && indexRef.current < anchors.length) {
      nextIndex = direction === 'next'
        ? (indexRef.current + 1) % anchors.length
        : (indexRef.current - 1 + anchors.length) % anchors.length;
    } else {
      const containerRect = container.getBoundingClientRect();
      const threshold = containerRect.top + FILE_SCROLL_MARGIN_TOP_PX;
      if (direction === 'next') {
        const visibleIndex = anchors.findIndex((element) => element.getBoundingClientRect().top >= threshold - 2);
        nextIndex = visibleIndex >= 0 ? visibleIndex : 0;
      } else {
        let previousIndex = -1;
        anchors.forEach((element, index) => {
          if (element.getBoundingClientRect().top < threshold - 2) {
            previousIndex = index;
          }
        });
        nextIndex = previousIndex >= 0 ? previousIndex : anchors.length - 1;
      }
    }

    indexRef.current = nextIndex;
    flashNavigationAnchor(anchors[nextIndex]);
    return true;
  }, [flashNavigationAnchor]);

  const resolveVisibleHunkTargetIndex = useCallback((direction: 'next' | 'prev'): number => {
    const container = containerRef.current;
    if (!container || hunkTargets.length === 0) return -1;
    const anchors = Array.from(container.querySelectorAll('[data-review-hunk-anchor="true"]'))
      .filter((element): element is HTMLElement => element instanceof HTMLElement);
    if (anchors.length === 0) return -1;

    const containerRect = container.getBoundingClientRect();
    const threshold = containerRect.top + FILE_SCROLL_MARGIN_TOP_PX;
    let anchor: HTMLElement | null = null;
    if (direction === 'next') {
      anchor = anchors.find((element) => element.getBoundingClientRect().top >= threshold - 2) || null;
    } else {
      for (const element of anchors) {
        if (element.getBoundingClientRect().top < threshold - 2) {
          anchor = element;
        } else {
          break;
        }
      }
    }
    if (!anchor) return -1;

    const path = anchor.getAttribute('data-review-hunk-file') || '';
    const line = Number.parseInt(anchor.getAttribute('data-review-hunk-line') || '', 10);
    if (!path || !Number.isFinite(line)) return -1;
    const key = getHunkNavigationTargetKey(path, line);
    return hunkTargets.findIndex((target) => target.key === key);
  }, [hunkTargets]);

  useEffect(() => {
    hunkAnchorIndexRef.current = null;
    hunkAnchorTargetKeyRef.current = null;
  }, [viewMode, activeFileFilter]);

  useEffect(() => {
    commentAnchorIndexRef.current = null;
  }, [files, viewMode, activeFileFilter]);

  useEffect(() => {
    if (!isFilesFeed) return;
    updateActiveFileFromScroll();
  }, [isFilesFeed, feedFiles, updateActiveFileFromScroll]);

  useEffect(() => () => {
    if (filesFeedViewportRafRef.current != null) {
      cancelAnimationFrame(filesFeedViewportRafRef.current);
      filesFeedViewportRafRef.current = null;
    }
    if (tokenizableRafRef.current != null) {
      cancelAnimationFrame(tokenizableRafRef.current);
      tokenizableRafRef.current = null;
    }
  }, []);

  // Capture the scroll container for Virtuoso's customScrollParent. Run after
  // first commit so the ref is populated.
  useLayoutEffect(() => {
    setVirtuosoScrollParent(containerRef.current);
  }, []);

  const flushTokenizableUpdates = useCallback(() => {
    tokenizableRafRef.current = null;
    if (tokenizablePendingRef.current.size === 0) return;
    setTokenizableFilePaths((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const path of tokenizablePendingRef.current) {
        if (!next.has(path)) {
          next.add(path);
          changed = true;
        }
      }
      tokenizablePendingRef.current.clear();
      return changed ? next : prev;
    });
  }, []);

  const enqueueTokenizable = useCallback((path: string) => {
    if (tokenizableFilePathsRef.current.has(path)) return;
    tokenizablePendingRef.current.add(path);
    if (tokenizableRafRef.current == null) {
      tokenizableRafRef.current = requestAnimationFrame(flushTokenizableUpdates);
    }
  }, [flushTokenizableUpdates]);

  // Viewport tracking is driven by Virtuoso's rangeChanged callback below
  // (see handleVirtuosoRangeChanged). We keep filesFeedViewportPathsRef as
  // the canonical "currently visible paths" set so other code can read it.
  const handleVirtuosoRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
    if (!isFilesFeed) return;
    const viewportPaths = filesFeedViewportPathsRef.current;
    viewportPaths.clear();
    const start = Math.max(0, range.startIndex);
    const end = Math.min(feedFilePaths.length - 1, range.endIndex);
    for (let i = start; i <= end; i += 1) {
      const path = feedFilePaths[i];
      if (!path) continue;
      viewportPaths.add(path);
      enqueueTokenizable(path);
    }
    if (onFilesFeedViewportChange) {
      if (filesFeedViewportRafRef.current != null) {
        cancelAnimationFrame(filesFeedViewportRafRef.current);
      }
      filesFeedViewportRafRef.current = requestAnimationFrame(() => {
        filesFeedViewportRafRef.current = null;
        const orderedPaths = feedFilePaths.filter((path) => viewportPaths.has(path));
        onFilesFeedViewportChange(orderedPaths);
      });
    }
  }, [isFilesFeed, feedFilePaths, onFilesFeedViewportChange, enqueueTokenizable]);

  useEffect(() => {
    if (!isFilesFeed || !filesFeedResetKey || filesFeedResetKeyRef.current === filesFeedResetKey) return;
    filesFeedResetKeyRef.current = filesFeedResetKey;
    const container = containerRef.current;
    if (!container) return;

    container.scrollTop = 0;
    if (virtuosoRef.current && feedFiles.length > 0) {
      virtuosoRef.current.scrollToIndex({ index: 0, behavior: 'auto', align: 'start' });
    }
    requestAnimationFrame(() => {
      container.scrollTop = 0;
      const firstPath = feedFiles[0]?.path;
      if (firstPath) {
        filesFeedActivePathRef.current = firstPath;
        onActiveFileChange?.(firstPath);
      }
    });
  }, [feedFiles, filesFeedResetKey, isFilesFeed, onActiveFileChange]);

  const scrollToFileInternal = useCallback((
    filePath: string,
    line?: number,
    options?: { side?: 'LEFT' | 'RIGHT' | null; suppressNearestDiffToast?: boolean },
  ): boolean => {
    const matchedFile = files.find((file) => (
      file.path === filePath
      || (typeof (file as SummaryFileEntry & { oldPath?: string | null }).oldPath === 'string'
        && (file as SummaryFileEntry & { oldPath?: string | null }).oldPath === filePath)
    ));
    if (!matchedFile) return false;
    const targetPath = matchedFile.path;
    if (isFilesFeed) {
      filesFeedActivePathRef.current = targetPath;
      onActiveFileChange?.(targetPath);
    }
    const bucketContainingFile = visibleTree.buckets.find((bucket) => (
      bucket.entries.some((entry) => entry.path === targetPath)
    ));

    if (bucketContainingFile) {
      setBucketExpandState((prev) => ({
        ...prev,
        [bucketContainingFile.id]: true,
      }));
    }

    if (!isFilesFeed) {
      setExpandState(prev => ({ ...prev, [targetPath]: true }));
    }

    if (onRequestContent) {
      if (matchedFile.contentLoaded === false && !matchedFile.contentLoading) {
        onRequestContent([targetPath]);
      }
    }

    // In feed mode the row may not be in the DOM yet (Virtuoso only mounts
    // what's near the viewport). Ask Virtuoso to scroll to the file's index;
    // the retry loop below picks up the rendered DOM once it's mounted.
    if (isFilesFeed && virtuosoRef.current) {
      const targetIndex = feedFiles.findIndex((file) => file.path === targetPath);
      if (targetIndex >= 0) {
        virtuosoRef.current.scrollToIndex({
          index: targetIndex,
          behavior: 'auto',
          align: 'start',
        });
      }
    }

    const scheduleRetry = (attempts: number) => {
      window.setTimeout(() => tryScroll(attempts + 1), 50);
    };

    const tryScroll = (attempts: number) => {
      if (attempts > 120) return;
      const container = containerRef.current;
      if (!container) return;

      const fileEl = container.querySelector(`[data-file-path="${CSS.escape(targetPath)}"]`);
      if (!fileEl) {
        scheduleRetry(attempts);
        return;
      }

      if (line) {
        // Huge files are render-capped to HUGE_FILE_RENDER_CAP rows and
        // expose their visible-window cap via this registry. If the target
        // line is past the cap, this flips renderAllLines so the next retry
        // can find the (now-mounted) line element. No-op when not capped.
        lineExpanderRegistryRef.current.get(targetPath)?.(line, options?.side ?? null);

        const preferredLineSelector = options?.side === 'LEFT'
          ? `[data-old-line="${line}"]`
          : `[data-new-line="${line}"]`;
        const commentAnchorSelector = options?.side
          ? `[data-review-comment-anchor="true"][data-review-comment-line="${line}"][data-review-comment-side="${options.side}"]`
          : `[data-review-comment-anchor="true"][data-review-comment-line="${line}"]`;
        const commentAnchor = fileEl.querySelector(commentAnchorSelector);
        if (commentAnchor) {
          flashNavigationAnchor(commentAnchor as HTMLElement);
          return;
        }

        const lineEl = fileEl.querySelector(preferredLineSelector);
        if (lineEl) {
          flashLineElement(lineEl);
          return;
        }

        if (!isFindingScopedDiff) {
          const collapsedLineSections = Array.from(
            fileEl.querySelectorAll('[data-collapsed-new-start][data-collapsed-new-end]')
          );
          const matchingCollapsedSection = collapsedLineSections.find((element) => {
            const start = Number.parseInt(element.getAttribute('data-collapsed-new-start') || '', 10);
            const end = Number.parseInt(element.getAttribute('data-collapsed-new-end') || '', 10);
            return Number.isFinite(start) && Number.isFinite(end) && line >= start && line <= end;
          });
          if (matchingCollapsedSection) {
            (matchingCollapsedSection as HTMLElement).click();
            scheduleRetry(attempts);
            return;
          }
        }

        const renderedNewLineElements = Array.from(
          fileEl.querySelectorAll('[data-new-line]')
        );
        if (renderedNewLineElements.length === 0 && attempts < 120) {
          scheduleRetry(attempts);
          return;
        }

        const renderedNewLineTarget = resolveRenderedLineTarget(
          renderedNewLineElements.map((element) => {
            const newLine = element.getAttribute('data-new-line');
            return newLine ? Number.parseInt(newLine, 10) : null;
          }),
          line
        );

        if (renderedNewLineTarget) {
          const fallbackLineEl = fileEl.querySelector(
            `[data-new-line="${renderedNewLineTarget.line}"]`
          );
          if (fallbackLineEl) {
            flashLineElement(fallbackLineEl);
            if (!renderedNewLineTarget.exact && !options?.suppressNearestDiffToast) {
              showNearestRenderedDiffToast(line, renderedNewLineTarget.line);
            }
            return;
          }
        }

        const renderedLineElements = Array.from(
          fileEl.querySelectorAll('[data-new-line], [data-old-line]')
        );
        const renderedLineTarget = resolveRenderedLineTarget(
          renderedLineElements.map((element) => {
            const newLine = element.getAttribute('data-new-line');
            const oldLine = element.getAttribute('data-old-line');
            return newLine ? Number.parseInt(newLine, 10) : (oldLine ? Number.parseInt(oldLine, 10) : null);
          }),
          line
        );
        if (renderedLineTarget) {
          const fallbackLineEl = fileEl.querySelector(
            `[data-new-line="${renderedLineTarget.line}"], [data-old-line="${renderedLineTarget.line}"]`
          );
          if (fallbackLineEl) {
            flashLineElement(fallbackLineEl);
            if (!renderedLineTarget.exact && !options?.suppressNearestDiffToast) {
              showNearestRenderedDiffToast(line, renderedLineTarget.line);
            }
            return;
          }
        }
      }

      fileEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    requestAnimationFrame(() => tryScroll(0));
    return true;
  }, [feedFiles, files, flashLineElement, flashNavigationAnchor, isFindingScopedDiff, isFilesFeed, onActiveFileChange, onRequestContent, visibleTree.buckets]);

  // Expose scroll-to-file method for Tree-mode line navigation
  useImperativeHandle(ref, () => ({
    scrollToFile: scrollToFileInternal,
    navigateHunk: (direction: 'next' | 'prev'): boolean => {
      if (hunkTargets.length === 0) return false;
      const hasCurrentTargetKey = hunkAnchorTargetKeyRef.current != null;
      const currentTargetIndex = hasCurrentTargetKey
        ? hunkTargets.findIndex((target) => target.key === hunkAnchorTargetKeyRef.current)
        : -1;
      const currentIndex = currentTargetIndex >= 0
        ? currentTargetIndex
        : (!hasCurrentTargetKey && hunkAnchorIndexRef.current != null && hunkAnchorIndexRef.current >= 0 && hunkAnchorIndexRef.current < hunkTargets.length
            ? hunkAnchorIndexRef.current
            : -1);
      const visibleIndex = currentIndex >= 0 ? -1 : resolveVisibleHunkTargetIndex(direction);
      const baseIndex = currentIndex >= 0
        ? currentIndex
        : (visibleIndex >= 0
            ? (direction === 'next' ? visibleIndex - 1 : visibleIndex + 1)
            : (direction === 'next' ? -1 : 0));
      const nextIndex = direction === 'next'
        ? (baseIndex + 1 + hunkTargets.length) % hunkTargets.length
        : (baseIndex - 1 + hunkTargets.length) % hunkTargets.length;
      hunkAnchorIndexRef.current = nextIndex;
      const target = hunkTargets[nextIndex];
      hunkAnchorTargetKeyRef.current = target?.key || null;
      return target ? scrollToFileInternal(target.path, target.line, { suppressNearestDiffToast: true }) : false;
    },
    navigateComment: (direction: 'next' | 'prev'): boolean => (
      navigateAnchors('[data-review-comment-anchor="true"]', direction, commentAnchorIndexRef)
    ),
  }), [hunkTargets, navigateAnchors, resolveVisibleHunkTargetIndex, scrollToFileInternal]);

  return (
    <LineExpanderRegistryContext.Provider value={lineExpanderRegistryRef.current}>
    <div
      ref={containerRef}
      onScroll={handleSummaryScroll}
      onMouseUp={updateAtlasDiffSelection}
      onKeyUp={updateAtlasDiffSelection}
      style={{
      flex: 1,
      overflow: 'auto',
      padding: 'var(--space-4)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-4)',
      background: 'var(--review-panel-bg)',
    }}>
      {atlasDiffSelection && onAskAtlasSelection && (
        <button
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onMouseUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            handleAskAtlasSelection();
          }}
          style={{
            position: 'fixed',
            top: atlasDiffSelection.rect.top,
            left: atlasDiffSelection.rect.left,
            zIndex: 40,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 11px 0 8px',
            borderRadius: 999,
            border: '1px solid rgba(var(--accent-blue-rgb), 0.36)',
            background: 'linear-gradient(180deg, rgba(20, 34, 57, 0.98), rgba(8, 14, 25, 0.98))',
            color: 'var(--text-primary)',
            boxShadow: '0 12px 30px rgba(0, 0, 0, 0.38), 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.05)',
            fontSize: 12,
            fontWeight: 700,
            fontFamily: 'var(--font-sans)',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <AtlasAiMark size={18} />
          Ask Atlas
        </button>
      )}
      <div style={{
        position: 'sticky',
        top: 'calc(var(--space-4) * -1)',
        zIndex: 6,
        margin: 'calc(var(--space-4) * -1) calc(var(--space-4) * -1) 0',
        padding: isFilesFeed
          ? 'var(--space-2) calc(var(--space-4) + var(--space-2))'
          : isFindingScopedDiff
          ? 'var(--space-3) calc(var(--space-4) + var(--space-2))'
          : 'var(--space-4) calc(var(--space-4) + var(--space-2)) var(--space-3)',
        ...reviewSurfaceStyle({ variant: 'toolbar', padded: false }),
        background: 'color-mix(in srgb, var(--review-toolbar-bg) 88%, var(--review-panel-bg) 12%)',
        borderRadius: 0,
        borderLeft: 'none',
        borderRight: 'none',
        borderTop: 'none',
        borderBottom: '1px solid var(--review-shell-divider)',
        display: 'grid',
        gap: isFindingScopedDiff || isFilesFeed ? 0 : 'var(--space-3)',
      }}>
        {/* Changed Files Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          padding: '0 var(--space-4)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
            <span className="review-shell-title" style={{
              fontSize: '16px',
              fontWeight: 600,
              color: 'var(--text-primary)',
              lineHeight: 1.1,
              minWidth: 0,
              display: isFindingScopedDiff || isFilesFeed ? 'none' : undefined,
            }}>
              Changed files ({visibleTree.totalVisibleCount})
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {isFindingScopedDiff || isFilesFeed ? (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', flexShrink: 0 }}>
                <ToggleButton label="Unified" isActive={viewMode === 'unified'} onClick={() => onViewModeChange?.('unified')} />
                <ToggleButton label="Split" isActive={viewMode === 'split'} onClick={() => onViewModeChange?.('split')} />
              </div>
            ) : !isFilesFeed ? (
              <ReviewActionButton
                type="button"
                onClick={toggleAll}
                tone="blue"
                style={{
                  minHeight: 'auto',
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--accent-blue)',
                  boxShadow: 'none',
                  fontSize: '10px',
                  fontWeight: 600,
                }}
              >
                {allExpanded ? 'Collapse all' : 'Expand all'}
              </ReviewActionButton>
            ) : null}
          </div>
        </div>

        {!isFindingScopedDiff && !isFilesFeed && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            padding: '0 var(--space-4)',
          }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              {!isFilesFeed && filters.map((filter) => {
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
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', flexShrink: 0 }}>
              <>
                <ToggleButton label="Unified" isActive={viewMode === 'unified'} onClick={() => onViewModeChange?.('unified')} />
                <ToggleButton label="Split" isActive={viewMode === 'split'} onClick={() => onViewModeChange?.('split')} />
              </>
            </div>
          </div>
        )}
      </div>

      {/* File List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: isFilesFeed ? 'var(--space-3)' : 'var(--space-2)', userSelect: 'none' }}>
        {isFilesFeed ? (
          feedFiles.length === 0 ? (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              No changed files in the current filter.
            </div>
          ) : virtuosoScrollParent ? (
            <Virtuoso
              ref={virtuosoRef}
              data={feedFiles}
              customScrollParent={virtuosoScrollParent}
              rangeChanged={handleVirtuosoRangeChanged}
              // Generous overscan: mount cards well before they enter the
              // viewport so WebKit-on-desktop has time to run the per-card
              // diff parse + Shiki tokenization without showing blank space
              // when the user scrolls. ~2400px ahead of the viewport on the
              // common scroll-down direction; ~600px above for back-scroll.
              increaseViewportBy={{ top: 600, bottom: 2400 }}
              computeItemKey={(_, file) => file.path}
              itemContent={(_, file) => (
                <div style={{ paddingBottom: 'var(--space-3)' }}>
                  <ExpandableFileRow
                    file={file}
                    entry={entryByPath.get(file.path)}
                    stats={fileStatsByPath.get(file.path)}
                    isExpanded
                    onToggle={() => {}}
                    feedMode
                    shouldTokenize={tokenizableFilePaths.has(file.path)}
                    viewMode={viewMode}
                    findingFocusLine={findingFocusLine}
                    recommendations={recommendations}
                    recommendationResolutions={recommendationResolutions}
                    githubConversationThreads={githubConversationThreads}
                    githubConversationPrAuthorLogin={githubConversationPrAuthorLogin}
                    githubConversationControls={githubConversationControls}
                    canCommentOnRecommendation={canCommentOnRecommendation}
                    getRecommendationComment={getRecommendationComment}
                    onSaveRecommendationComment={onSaveRecommendationComment}
                    onClearRecommendationComment={onClearRecommendationComment}
                    canAddRecommendationNotes={canAddRecommendationNotes}
                    getRecommendationNote={getRecommendationNote}
                    onSaveRecommendationNote={onSaveRecommendationNote}
                    onClearRecommendationNote={onClearRecommendationNote}
                    canCommentOnAnyLine={canCommentOnAnyLine}
                    commentingUnavailableReason={commentingUnavailableReason}
                    getManualLineComment={getManualLineComment}
                    onSaveManualLineComment={onSaveManualLineComment}
                    onClearManualLineComment={onClearManualLineComment}
                    canAddPrivateNotes={canAddPrivateNotes}
                    getPrivateNote={getPrivateNote}
                    onSavePrivateNote={onSavePrivateNote}
                    onClearPrivateNote={onClearPrivateNote}
                    getFilePrivateNote={getFilePrivateNote}
                    onSaveFilePrivateNote={onSaveFilePrivateNote}
                    onClearFilePrivateNote={onClearFilePrivateNote}
                    onAskAtlasFinding={onAskAtlasFinding}
                    onAskAtlasFile={onAskAtlasFile}
                  />
                </div>
              )}
            />
          ) : null
        ) : (
          <>
        {visibleTree.standaloneEntries.map((entry) => {
          const file = fileByPath.get(entry.path);
          if (!file) return null;
          return (
            <ExpandableFileRow
              key={file.path}
              file={file}
              entry={entry}
              stats={fileStatsByPath.get(file.path)}
              isExpanded={isFileExpanded(file.path)}
              onToggle={() => handleToggle(file.path)}
              viewMode={viewMode}
              findingFocusLine={findingFocusLine}
              recommendations={recommendations}
              recommendationResolutions={recommendationResolutions}
              githubConversationThreads={githubConversationThreads}
              githubConversationPrAuthorLogin={githubConversationPrAuthorLogin}
              githubConversationControls={githubConversationControls}
              canCommentOnRecommendation={canCommentOnRecommendation}
              getRecommendationComment={getRecommendationComment}
              onSaveRecommendationComment={onSaveRecommendationComment}
              onClearRecommendationComment={onClearRecommendationComment}
              canAddRecommendationNotes={canAddRecommendationNotes}
              getRecommendationNote={getRecommendationNote}
              onSaveRecommendationNote={onSaveRecommendationNote}
              onClearRecommendationNote={onClearRecommendationNote}
              canCommentOnAnyLine={canCommentOnAnyLine}
              commentingUnavailableReason={commentingUnavailableReason}
              getManualLineComment={getManualLineComment}
              onSaveManualLineComment={onSaveManualLineComment}
              onClearManualLineComment={onClearManualLineComment}
              canAddPrivateNotes={canAddPrivateNotes}
              getPrivateNote={getPrivateNote}
              onSavePrivateNote={onSavePrivateNote}
              onClearPrivateNote={onClearPrivateNote}
              getFilePrivateNote={getFilePrivateNote}
              onSaveFilePrivateNote={onSaveFilePrivateNote}
              onClearFilePrivateNote={onClearFilePrivateNote}
              onAskAtlasFinding={onAskAtlasFinding}
              onAskAtlasFile={onAskAtlasFile}
            />
          );
        })}
        {visibleTree.buckets.map((bucket) => (
          <SummaryBucketSection
            key={bucket.id}
            bucket={bucket}
            fileByPath={fileByPath}
            fileStatsByPath={fileStatsByPath}
            isExpanded={bucketExpandState[bucket.id] ?? !bucket.defaultCollapsed}
            onToggle={() => {
              setBucketExpandState((prev) => ({
                ...prev,
                [bucket.id]: !(prev[bucket.id] ?? !bucket.defaultCollapsed),
              }));
            }}
            isFileExpanded={isFileExpanded}
            onToggleFile={handleToggle}
            viewMode={viewMode}
            findingFocusLine={findingFocusLine}
            recommendations={recommendations}
            recommendationResolutions={recommendationResolutions}
            githubConversationThreads={githubConversationThreads}
            githubConversationPrAuthorLogin={githubConversationPrAuthorLogin}
            githubConversationControls={githubConversationControls}
            canCommentOnRecommendation={canCommentOnRecommendation}
            getRecommendationComment={getRecommendationComment}
            onSaveRecommendationComment={onSaveRecommendationComment}
            onClearRecommendationComment={onClearRecommendationComment}
            canAddRecommendationNotes={canAddRecommendationNotes}
            getRecommendationNote={getRecommendationNote}
            onSaveRecommendationNote={onSaveRecommendationNote}
            onClearRecommendationNote={onClearRecommendationNote}
            canCommentOnAnyLine={canCommentOnAnyLine}
            commentingUnavailableReason={commentingUnavailableReason}
            getManualLineComment={getManualLineComment}
            onSaveManualLineComment={onSaveManualLineComment}
            onClearManualLineComment={onClearManualLineComment}
            canAddPrivateNotes={canAddPrivateNotes}
            getPrivateNote={getPrivateNote}
            onSavePrivateNote={onSavePrivateNote}
            onClearPrivateNote={onClearPrivateNote}
            getFilePrivateNote={getFilePrivateNote}
            onSaveFilePrivateNote={onSaveFilePrivateNote}
            onClearFilePrivateNote={onClearFilePrivateNote}
            onAskAtlasFinding={onAskAtlasFinding}
            onAskAtlasFile={onAskAtlasFile}
          />
        ))}
        {visibleTree.totalVisibleCount === 0 && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            No changed files in the current filter.
          </div>
        )}
          </>
        )}
      </div>
    </div>
    </LineExpanderRegistryContext.Provider>
  );
});

function ToggleButton({
  label,
  isActive,
  onClick,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 24,
        padding: '0 0 6px',
        borderRadius: 0,
        border: 'none',
        borderBottom: `2px solid ${isActive ? 'var(--accent-blue)' : 'transparent'}`,
        background: 'transparent',
        color: isActive ? 'var(--accent-blue)' : 'var(--text-secondary)',
        fontSize: '10px',
        fontFamily: 'var(--font-sans)',
        fontWeight: isActive ? 700 : 600,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function ManualLineCommentThread({
  filePath,
  lineNumber,
  side = 'RIGHT',
  canComment,
  isComposerOpen,
  commentText,
  onSave,
  onClear,
  onRequestOpen,
  onRequestClose,
}: {
  filePath: string;
  lineNumber: number | null | undefined;
  side?: 'LEFT' | 'RIGHT';
  canComment: boolean;
  isComposerOpen: boolean;
  commentText?: string;
  onSave?: (path: string, line: number, comment: string, side?: 'LEFT' | 'RIGHT') => void;
  onClear?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  onRequestOpen?: () => void;
  onRequestClose?: () => void;
}) {
  const normalizedLine = Number.isFinite(Number(lineNumber)) && Number(lineNumber) > 0
    ? Math.floor(Number(lineNumber))
    : null;
  const normalizedCommentText = typeof commentText === 'string' ? commentText.trim() : '';
  const hasComment = normalizedCommentText.length > 0;
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isComposerOpen) {
      setDraft(normalizedCommentText);
    }
  }, [isComposerOpen, normalizedCommentText]);

  useEffect(() => {
    if (!isComposerOpen) return;
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const valueLength = textareaRef.current?.value.length ?? 0;
      textareaRef.current?.setSelectionRange(valueLength, valueLength);
    });
  }, [isComposerOpen]);

  if (!canComment || !normalizedLine) return null;
  if (!isComposerOpen && !hasComment) return null;

  return (
    <div
      data-review-comment-anchor="true"
      data-review-comment-file={filePath}
      data-review-comment-line={normalizedLine}
      data-review-comment-side={side}
      style={{ margin: '4px 0 0 calc(var(--line-num-width) * 2 + 4px)' }}
    >
      {hasComment && !isComposerOpen && (
        <div style={{
          padding: '10px 12px',
          background: 'var(--review-card-bg)',
          border: '1px solid var(--review-shell-divider)',
          borderRadius: 8,
        }}>
          <ManualLineCommentAuthor line={normalizedLine} />
          <div style={{
            fontSize: 12,
            color: 'var(--text-primary)',
            lineHeight: 1.5,
            fontFamily: 'var(--font-sans)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: 'var(--space-2)',
          }}>
            {normalizedCommentText}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
            <ReviewActionButton
              onClick={() => {
                setDraft(normalizedCommentText);
                onRequestOpen?.();
              }}
              tone="blue"
              style={{ minHeight: 24, padding: '0 8px', fontSize: 10 }}
            >
              Edit
            </ReviewActionButton>
            <ReviewActionButton
              onClick={() => onClear?.(filePath, normalizedLine, side)}
              tone="neutral"
              style={{ minHeight: 24, padding: '0 8px', fontSize: 10 }}
            >
              Remove
            </ReviewActionButton>
          </div>
        </div>
      )}

      {isComposerOpen && (
        <div
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault();
            }
            event.stopPropagation();
          }}
          onClick={(event) => event.stopPropagation()}
          style={{
            padding: '10px 12px',
            background: 'var(--review-card-bg)',
            border: '1px solid var(--review-shell-divider)',
            borderRadius: 8,
          }}
        >
          <ManualLineCommentAuthor line={normalizedLine} />
          <textarea
            autoFocus
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            onFocus={(event) => event.stopPropagation()}
            rows={4}
            style={{
              width: '100%',
              resize: 'vertical',
              minHeight: 92,
              borderRadius: 6,
              border: '1px solid var(--review-shell-divider)',
              background: 'var(--review-code-bg)',
              color: 'var(--text-primary)',
              padding: '10px 12px',
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
              boxSizing: 'border-box',
              userSelect: 'text',
            }}
          />
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            flexWrap: 'wrap',
            marginTop: 10,
          }}>
            <ReviewActionButton
              onClick={() => {
                const trimmed = draft.trim();
                if (!trimmed) return;
                onSave?.(filePath, normalizedLine, trimmed, side);
                onRequestClose?.();
              }}
              tone="blue"
              disabled={!draft.trim()}
              style={{ minHeight: 28, padding: '0 10px' }}
            >
              Comment
            </ReviewActionButton>
            <ReviewActionButton
              onClick={() => {
                setDraft(normalizedCommentText);
                onRequestClose?.();
              }}
              tone="neutral"
              style={{ minHeight: 28, padding: '0 10px' }}
            >
              Cancel
            </ReviewActionButton>
          </div>
        </div>
      )}
    </div>
  );
}

function PrivateLineNoteThread({
  filePath,
  lineNumber,
  side = 'RIGHT',
  isComposerOpen,
  noteText,
  onSave,
  onClear,
  onRequestOpen,
  onRequestClose,
}: {
  filePath: string;
  lineNumber: number | null | undefined;
  side?: 'LEFT' | 'RIGHT';
  isComposerOpen: boolean;
  noteText?: string;
  onSave?: (path: string, line: number, note: string, side?: 'LEFT' | 'RIGHT') => void;
  onClear?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  onRequestOpen?: () => void;
  onRequestClose?: () => void;
}) {
  const normalizedLine = Number.isFinite(Number(lineNumber)) && Number(lineNumber) > 0
    ? Math.floor(Number(lineNumber))
    : null;
  const normalizedNoteText = typeof noteText === 'string' ? noteText.trim() : '';
  const hasNote = normalizedNoteText.length > 0;
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isComposerOpen) {
      setDraft(normalizedNoteText);
    }
  }, [isComposerOpen, normalizedNoteText]);

  useEffect(() => {
    if (!isComposerOpen) return;
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const valueLength = textareaRef.current?.value.length ?? 0;
      textareaRef.current?.setSelectionRange(valueLength, valueLength);
    });
  }, [isComposerOpen]);

  if (!normalizedLine) return null;
  if (!isComposerOpen && !hasNote) return null;

  return (
    <div style={{ margin: '4px 0 0 calc(var(--line-num-width) * 2 + 30px)' }}>
      {hasNote && !isComposerOpen && (
        <div style={{
          padding: 'var(--space-2)',
          background: 'rgba(212, 175, 55, 0.08)',
          border: '1px solid rgba(212, 175, 55, 0.18)',
          borderRadius: 12,
        }}>
          <div style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--accent-yellow)',
            marginBottom: 'var(--space-1)',
          }}>
            Private note
          </div>
          <div style={{
            fontSize: 12,
            color: 'var(--text-primary)',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: 'var(--space-2)',
          }}>
            {normalizedNoteText}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
            <ReviewActionButton
              onClick={() => {
                setDraft(normalizedNoteText);
                onRequestOpen?.();
              }}
              tone="yellow"
              style={{ minHeight: 24, padding: '0 8px', fontSize: 10 }}
            >
              Edit
            </ReviewActionButton>
            <ReviewActionButton
              onClick={() => onClear?.(filePath, normalizedLine, side)}
              tone="neutral"
              style={{ minHeight: 24, padding: '0 8px', fontSize: 10 }}
            >
              Remove
            </ReviewActionButton>
          </div>
        </div>
      )}

      {isComposerOpen && (
        <div
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              event.preventDefault();
            }
            event.stopPropagation();
          }}
          onClick={(event) => event.stopPropagation()}
          style={{
            padding: 'var(--space-2)',
            background: 'rgba(212, 175, 55, 0.08)',
            border: '1px solid rgba(212, 175, 55, 0.18)',
            borderRadius: 12,
          }}
        >
          <div style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--accent-yellow)',
            marginBottom: 'var(--space-1)',
          }}>
            Private note on line {normalizedLine}
          </div>
          <textarea
            autoFocus
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            onFocus={(event) => event.stopPropagation()}
            rows={4}
            style={{
              width: '100%',
              resize: 'vertical',
              minHeight: 88,
              borderRadius: 10,
              border: '1px solid var(--review-shell-border)',
              background: 'var(--review-code-bg)',
              color: 'var(--text-primary)',
              padding: '10px 12px',
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
              boxSizing: 'border-box',
              userSelect: 'text',
            }}
          />
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            flexWrap: 'wrap',
            marginTop: 'var(--space-2)',
          }}>
            <ReviewActionButton
              onClick={() => {
                const trimmed = draft.trim();
                if (!trimmed) return;
                onSave?.(filePath, normalizedLine, trimmed, side);
                onRequestClose?.();
              }}
              tone="yellow"
              disabled={!draft.trim()}
              style={{ minHeight: 28, padding: '0 10px' }}
            >
              Save note
            </ReviewActionButton>
            <ReviewActionButton
              onClick={() => {
                setDraft(normalizedNoteText);
                onRequestClose?.();
              }}
              tone="neutral"
              style={{ minHeight: 28, padding: '0 10px' }}
            >
              Cancel
            </ReviewActionButton>
          </div>
        </div>
      )}
    </div>
  );
}

function GitHubConversationInlineThreads({
  filePath,
  lineNumber,
  side,
  threads,
  prAuthorLogin,
  controls,
}: {
  filePath: string;
  lineNumber: number | null | undefined;
  side: 'LEFT' | 'RIGHT';
  threads: GitHubPrReviewThread[] | undefined;
  prAuthorLogin?: string | null;
  controls?: GitHubConversationInlineControls;
}) {
  const normalizedLine = Number.isFinite(Number(lineNumber)) && Number(lineNumber) > 0
    ? Math.floor(Number(lineNumber))
    : null;
  if (!normalizedLine || !threads || threads.length === 0) return null;

  return (
    <div
      data-review-comment-anchor="true"
      data-review-comment-file={filePath}
      data-review-comment-line={normalizedLine}
      data-review-comment-side={side}
      data-review-github-comment-anchor="true"
      style={{ margin: '4px 0 0 calc(var(--line-num-width) * 2 + 4px)' }}
    >
      {threads.map((thread) => (
        <GitHubConversationInlineThreadCard
          key={thread.id}
          thread={thread}
          prAuthorLogin={prAuthorLogin}
          controls={controls}
        />
      ))}
    </div>
  );
}

function getGitHubConversationInlinePreview(body: string | null | undefined): string {
  return String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#>*_\-[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function GitHubConversationInlineThreadCard({
  thread,
  prAuthorLogin,
  controls,
}: {
  thread: GitHubPrReviewThread;
  prAuthorLogin?: string | null;
  controls?: GitHubConversationInlineControls;
}) {
  const [isReplying, setIsReplying] = useState(false);
  const [isResolvedExpanded, setIsResolvedExpanded] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const firstComment = thread.comments[0] || null;
  const comments = thread.comments.length > 0 ? thread.comments : [];
  const lastComment = thread.comments[thread.comments.length - 1] || firstComment;
  const isBusy = controls?.busyThreadId === thread.id;
  const normalizedReplyDraft = replyDraft.trim();
  const isCollapsedResolved = thread.isResolved && !isResolvedExpanded;
  const previewText = getGitHubConversationInlinePreview(firstComment?.bodyText || firstComment?.body).slice(0, 180);
  const borderAccent = thread.isResolved
    ? 'var(--sev-ok)'
    : thread.isOutdated
      ? 'var(--sev-med)'
      : 'var(--accent-blue)';

  useEffect(() => {
    setIsResolvedExpanded(false);
    setIsReplying(false);
    setReplyDraft('');
    setLocalError(null);
  }, [thread.id, thread.isResolved]);

  const submitReply = async () => {
    if (!controls?.onReplyThread || !normalizedReplyDraft || isBusy) return;
    setLocalError(null);
    try {
      await controls.onReplyThread(thread, normalizedReplyDraft);
      setReplyDraft('');
      setIsReplying(false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to reply to GitHub conversation');
    }
  };

  const updateResolution = async () => {
    if (!controls?.onSetThreadResolved || isBusy) return;
    setLocalError(null);
    try {
      await controls.onSetThreadResolved(thread, !thread.isResolved);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Failed to update GitHub conversation');
    }
  };

  return (
    <div
      style={{
        padding: '10px 12px',
        background: thread.isOutdated ? 'var(--review-panel-alt-bg)' : 'var(--review-card-bg)',
        border: `1px solid ${thread.isOutdated ? 'var(--border-default)' : 'var(--review-shell-divider)'}`,
        borderLeft: `3px solid ${borderAccent}`,
        borderRadius: 8,
        fontFamily: 'var(--font-sans)',
        marginBottom: 6,
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}>
          GitHub conversation
        </span>
        {thread.isResolved && (
          <button
            type="button"
            onClick={() => setIsResolvedExpanded((prev) => !prev)}
            title={isResolvedExpanded ? 'Collapse resolved conversation' : 'Expand resolved conversation'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--sev-ok)',
              border: '1px solid var(--sev-ok)',
              borderRadius: 3,
              padding: '1px 5px',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 9, lineHeight: 1 }}>
              {isResolvedExpanded ? 'v' : '>'}
            </span>
            Resolved
          </button>
        )}
        {thread.isOutdated && (
          <span style={{
            fontSize: 10,
            color: 'var(--sev-med)',
            border: '1px solid var(--sev-med)',
            borderRadius: 3,
            padding: '1px 5px',
            background: 'color-mix(in oklab, var(--sev-med) 12%, transparent)',
            fontWeight: 700,
          }}>
            Outdated
          </span>
        )}
        <span
          title={formatGitHubConversationExactTime(lastComment?.updatedAt || thread.lastCommentAt || thread.syncedAt)}
          style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginLeft: 'auto' }}
        >
          {formatGitHubConversationTime(lastComment?.updatedAt || thread.lastCommentAt || thread.syncedAt)}
        </span>
      </div>
      {isCollapsedResolved ? (
        <div style={{
          fontSize: 11,
          color: 'var(--text-secondary)',
          lineHeight: 1.45,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {previewText || 'Resolved conversation'}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {comments.length > 0 ? comments.map((comment: GitHubPrThreadComment) => (
            <GitHubConversationComment
              key={comment.id}
              comment={comment}
              isReply={Boolean(comment.replyToNodeId)}
              isBusy={isBusy || controls?.busyCommentId === comment.id}
              prAuthorLogin={prAuthorLogin}
              onUpdate={controls?.onUpdateComment}
              onDelete={controls?.onDeleteComment}
              onConfirmDelete={controls?.onConfirmDeleteComment}
            />
          )) : (
            <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-primary)' }}>
              No comment body
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10.5, color: 'var(--text-tertiary)' }}>
        <span>{thread.commentCount} comment{thread.commentCount === 1 ? '' : 's'}</span>
        <span title={formatGitHubConversationExactTime(lastComment?.updatedAt || thread.lastCommentAt || thread.syncedAt)}>
          {formatGitHubConversationTime(lastComment?.updatedAt || thread.lastCommentAt || thread.syncedAt)}
        </span>
        {thread.resolvedByLogin && <span>Resolved by {thread.resolvedByLogin}</span>}
      </div>
      {(controls?.onAskAgent || controls?.onReplyThread || controls?.onSetThreadResolved) && !isCollapsedResolved && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {controls?.onAskAgent && (
            <button
              type="button"
              onClick={() => controls.onAskAgent?.(thread)}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: isBusy ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              Ask Atlas
            </button>
          )}
          {controls?.onReplyThread && (
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                setIsReplying((prev) => !prev);
              }}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: isBusy ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              Reply
            </button>
          )}
          {controls?.onSetThreadResolved && (
            <button
              type="button"
              onClick={() => {
                void updateResolution();
              }}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: isBusy ? 'var(--text-tertiary)' : (thread.isResolved ? 'var(--text-secondary)' : 'var(--sev-ok)'),
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              {isBusy ? 'Updating...' : thread.isResolved ? 'Reopen' : 'Resolve'}
            </button>
          )}
        </div>
      )}
      {isReplying && (
        <div style={{ display: 'grid', gap: 6 }}>
          <textarea
            value={replyDraft}
            onChange={(event) => setReplyDraft(event.target.value)}
            placeholder="Reply on GitHub..."
            rows={3}
            disabled={isBusy}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              minHeight: 70,
              borderRadius: 4,
              border: '1px solid var(--border-default)',
              background: 'var(--review-code-bg)',
              color: 'var(--text-primary)',
              padding: '8px 10px',
              fontSize: 12,
              lineHeight: 1.45,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => {
                void submitReply();
              }}
              disabled={isBusy || !normalizedReplyDraft}
              style={{
                fontSize: 10,
                color: isBusy || !normalizedReplyDraft ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy || !normalizedReplyDraft ? 'default' : 'pointer',
              }}
            >
              {isBusy ? 'Sending...' : 'Send reply'}
            </button>
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                setReplyDraft('');
                setIsReplying(false);
              }}
              disabled={isBusy}
              style={{
                fontSize: 10,
                color: 'var(--text-secondary)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 3,
                padding: '2px 7px',
                cursor: isBusy ? 'default' : 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {localError && (
        <div style={{ fontSize: 10.5, color: 'var(--accent-red)', lineHeight: 1.4 }}>
          {localError}
        </div>
      )}
    </div>
  );
}

function FilePrivateNoteThread({
  filePath,
  noteText,
  isComposerOpen,
  onSave,
  onClear,
  onRequestOpen,
  onRequestClose,
}: {
  filePath: string;
  noteText?: string;
  isComposerOpen: boolean;
  onSave?: (path: string, note: string) => void;
  onClear?: (path: string) => void;
  onRequestOpen?: () => void;
  onRequestClose?: () => void;
}) {
  const normalizedNoteText = typeof noteText === 'string' ? noteText.trim() : '';
  const hasNote = normalizedNoteText.length > 0;
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isComposerOpen) {
      setDraft(normalizedNoteText);
    }
  }, [isComposerOpen, normalizedNoteText]);

  useEffect(() => {
    if (!isComposerOpen) return;
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const valueLength = textareaRef.current?.value.length ?? 0;
      textareaRef.current?.setSelectionRange(valueLength, valueLength);
    });
  }, [isComposerOpen]);

  if (!isComposerOpen && !hasNote) return null;

  return (
    <div style={{
      padding: 'var(--space-2)',
      background: 'rgba(212, 175, 55, 0.08)',
      border: '1px solid rgba(212, 175, 55, 0.18)',
      borderRadius: 12,
    }}>
      {hasNote && !isComposerOpen ? (
        <>
          <div style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--accent-yellow)',
            marginBottom: 'var(--space-1)',
          }}>
            Private file note
          </div>
          <div style={{
            fontSize: 12,
            color: 'var(--text-primary)',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: 'var(--space-2)',
          }}>
            {normalizedNoteText}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
            <ReviewActionButton
              onClick={() => {
                setDraft(normalizedNoteText);
                onRequestOpen?.();
              }}
              tone="yellow"
              style={{ minHeight: 24, padding: '0 8px', fontSize: 10 }}
            >
              Edit
            </ReviewActionButton>
            <ReviewActionButton
              onClick={() => onClear?.(filePath)}
              tone="neutral"
              style={{ minHeight: 24, padding: '0 8px', fontSize: 10 }}
            >
              Remove
            </ReviewActionButton>
          </div>
        </>
      ) : (
        <>
          <div style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--accent-yellow)',
            marginBottom: 'var(--space-1)',
          }}>
            Private file note
          </div>
          <textarea
            autoFocus
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            onFocus={(event) => event.stopPropagation()}
            rows={4}
            style={{
              width: '100%',
              resize: 'vertical',
              minHeight: 88,
              borderRadius: 10,
              border: '1px solid var(--review-shell-border)',
              background: 'var(--review-code-bg)',
              color: 'var(--text-primary)',
              padding: '10px 12px',
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
              boxSizing: 'border-box',
              userSelect: 'text',
            }}
          />
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            flexWrap: 'wrap',
            marginTop: 'var(--space-2)',
          }}>
            <ReviewActionButton
              onClick={() => {
                const trimmed = draft.trim();
                if (!trimmed) return;
                onSave?.(filePath, trimmed);
                onRequestClose?.();
              }}
              tone="yellow"
              disabled={!draft.trim()}
              style={{ minHeight: 28, padding: '0 10px' }}
            >
              Save note
            </ReviewActionButton>
            <ReviewActionButton
              onClick={() => {
                setDraft(normalizedNoteText);
                onRequestClose?.();
              }}
              tone="neutral"
              style={{ minHeight: 28, padding: '0 10px' }}
            >
              Cancel
            </ReviewActionButton>
          </div>
        </>
      )}
    </div>
  );
}

// ── Expandable File Row ────────────────────────────────────────────────

function ExpandableFileRow({
  file,
  entry,
  stats,
  isExpanded,
  onToggle,
  viewMode,
  findingFocusLine,
  recommendations,
  recommendationResolutions = {},
  githubConversationThreads,
  githubConversationPrAuthorLogin,
  githubConversationControls,
  canCommentOnRecommendation,
  getRecommendationComment,
  onSaveRecommendationComment,
  onClearRecommendationComment,
  canAddRecommendationNotes,
  getRecommendationNote,
  onSaveRecommendationNote,
  onClearRecommendationNote,
  canCommentOnAnyLine,
  commentingUnavailableReason,
  getManualLineComment,
  onSaveManualLineComment,
  onClearManualLineComment,
  canAddPrivateNotes,
  getPrivateNote,
  onSavePrivateNote,
  onClearPrivateNote,
  getFilePrivateNote,
  onSaveFilePrivateNote,
  onClearFilePrivateNote,
  onAskAtlasFinding,
  onAskAtlasFile,
  feedMode = false,
  shouldTokenize = true,
}: {
  file: SummaryFileEntry;
  entry?: ReviewFileTreeEntry;
  stats?: { additions: number; deletions: number };
  isExpanded: boolean;
  onToggle: () => void;
  viewMode: 'unified' | 'split';
  findingFocusLine?: number | null;
  recommendations?: ReviewRecommendation[];
  recommendationResolutions?: RecommendationResolutionMap;
  githubConversationThreads?: GitHubPrReviewThread[];
  githubConversationPrAuthorLogin?: string | null;
  githubConversationControls?: GitHubConversationInlineControls;
  canCommentOnRecommendation: boolean;
  getRecommendationComment?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationComment?: (rec: ReviewRecommendation, comment: string) => void;
  onClearRecommendationComment?: (rec: ReviewRecommendation) => void;
  canAddRecommendationNotes: boolean;
  getRecommendationNote?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationNote?: (rec: ReviewRecommendation, note: string) => void;
  onClearRecommendationNote?: (rec: ReviewRecommendation) => void;
  canCommentOnAnyLine: boolean;
  commentingUnavailableReason?: string | null;
  getManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSaveManualLineComment?: (path: string, line: number, comment: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  canAddPrivateNotes: boolean;
  getPrivateNote?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSavePrivateNote?: (path: string, line: number, note: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearPrivateNote?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  getFilePrivateNote?: (path: string) => string;
  onSaveFilePrivateNote?: (path: string, note: string) => void;
  onClearFilePrivateNote?: (path: string) => void;
  onAskAtlasFinding?: (rec: ReviewRecommendation) => void;
  onAskAtlasFile?: (path: string) => void;
  feedMode?: boolean;
  /**
   * In feed mode the parent passes `false` for off-screen files so
   * `useSyntaxTokens` skips the work until the row enters the viewport.
   * Defaults to `true` for non-feed callers (accordion / single-file views).
   */
  shouldTokenize?: boolean;
}) {
  const status = resolveStatus(file);
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.M;
  const additions = stats?.additions ?? file.additions ?? 0;
  const deletions = stats?.deletions ?? file.deletions ?? 0;
  const fileName = file.path.split('/').pop() || file.path;
  const filePrivateNote = getFilePrivateNote?.(file.path) || '';
  const hasFilePrivateNote = Boolean(filePrivateNote.trim());
  const [isFileNoteOpen, setIsFileNoteOpen] = useState(false);
  const [isFileNoteHovered, setIsFileNoteHovered] = useState(false);
  const showAddFileNoteAffordance = !hasFilePrivateNote && isFileNoteHovered;

  return (
    <div data-file-path={file.path} style={{
      ...getReviewCardStyle({ expanded: feedMode || isExpanded }),
      overflow: 'hidden',
      scrollMarginTop: FILE_SCROLL_MARGIN_TOP_PX,
      contentVisibility: feedMode ? 'auto' : undefined,
      containIntrinsicSize: feedMode ? `auto ${Math.max(160, Math.min(1200, ((file.additions || 0) + (file.deletions || 0)) * 22 + 92))}px` : undefined,
    }}>
      {/* File header */}
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 'var(--space-2)',
        padding: 'var(--space-2) var(--space-3)',
        background: (feedMode || isExpanded) ? 'var(--review-card-hover)' : 'transparent',
        transition: 'background var(--transition-fast)',
      }}>
      <button
        type="button"
        onClick={feedMode ? undefined : onToggle}
        tabIndex={feedMode ? -1 : undefined}
        aria-disabled={feedMode ? true : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 0,
          background: 'transparent',
          border: 'none',
          cursor: feedMode ? 'default' : 'pointer',
          textAlign: 'left',
        }}
      >
        {/* Expand chevron */}
        {!feedMode && (
          <span style={{
            fontSize: 10,
            color: 'var(--text-tertiary)',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0)',
            transition: 'transform var(--transition-fast)',
            flexShrink: 0,
          }}>
            ▶
          </span>
        )}

        {/* Status icon */}
        <span style={{
          fontWeight: 700,
          fontSize: 'var(--text-xs)',
          color: cfg.color,
          flexShrink: 0,
          width: 12,
          textAlign: 'center',
        }}>
          {cfg.icon}
        </span>

        {entry && (
          <span
            title={entry.findingCount > 0 ? `${entry.findingCount} finding${entry.findingCount === 1 ? '' : 's'}` : 'No findings'}
            style={{
              minWidth: entry.findingCount > 0 ? 28 : 10,
              height: entry.findingCount > 0 ? 20 : 10,
              padding: entry.findingCount > 0 ? '0 7px 0 6px' : 0,
              borderRadius: 999,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: entry.findingCount > 0 ? 5 : 0,
              background: entry.findingCount > 0
                ? RISK_BG_COLORS[entry.highestFindingSeverity || 'medium']
                : 'var(--review-chip-neutral-bg)',
              color: entry.findingCount > 0
                ? RISK_COLORS[entry.highestFindingSeverity || 'medium']
                : 'var(--text-tertiary)',
              border: entry.findingCount > 0
                ? `1px solid ${RISK_COLORS[entry.highestFindingSeverity || 'medium']}33`
                : '1px solid var(--border-muted)',
              boxShadow: entry.findingCount > 0
                ? `inset 0 0 0 1px ${RISK_COLORS[entry.highestFindingSeverity || 'medium']}12`
                : 'none',
              fontSize: entry.findingCount > 0 ? 11 : 9,
              fontWeight: 800,
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            {entry.findingCount > 0 ? (
              <>
                <span style={{ fontSize: 9, lineHeight: 1 }}>●</span>
                <span>{entry.findingCount}</span>
              </>
            ) : '•'}
          </span>
        )}

        {/* File path */}
        <span style={{
          fontSize: 'var(--text-xs)',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={file.path}
        >
          {fileName}
          <span style={{
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-sans)',
            fontSize: 10,
            marginLeft: 'var(--space-1)',
          }}>
            {file.path !== fileName ? file.path.slice(0, -(fileName.length + 1)) + '/' : ''}
          </span>
        </span>

        {/* Stats */}
        <span style={{
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-tertiary)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}>
          {additions > 0 && <span style={{ color: 'var(--accent-green)' }}>+{additions}</span>}
          {deletions > 0 && <span style={{ color: 'var(--accent-red)' }}>-{deletions}</span>}
        </span>

        {/* Status badge */}
        <span style={{
          padding: '1px 8px',
          borderRadius: 'var(--radius-full)',
          fontSize: 10,
          fontWeight: 700,
          color: cfg.color,
          background: cfg.bg,
          border: `1px solid ${cfg.color}26`,
          flexShrink: 0,
        }}>
          {cfg.label}
        </span>
      </button>
      {onAskAtlasFile && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAskAtlasFile(file.path);
          }}
          aria-label="Ask Atlas about this file"
          title="Ask Atlas to explain the changes in this file"
          style={{
            background: 'transparent',
            border: '1px solid var(--border-muted)',
            color: 'var(--accent-blue)',
            cursor: 'pointer',
            padding: '3px 7px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 650,
            flexShrink: 0,
            alignSelf: 'center',
          }}
        >
          Ask Atlas
        </button>
      )}
      {canAddPrivateNotes && (
        <button
          type="button"
          onClick={() => setIsFileNoteOpen((prev) => !prev)}
          title={hasFilePrivateNote ? 'View file note' : 'Add file note'}
          className="file-note-dot"
          style={{
            width: showAddFileNoteAffordance ? 12 : 8,
            height: showAddFileNoteAffordance ? 12 : 8,
            borderRadius: '50%',
            background: hasFilePrivateNote
              ? 'var(--accent-yellow, #f59e0b)'
              : showAddFileNoteAffordance
                ? 'transparent'
                : 'var(--text-tertiary)',
            border: showAddFileNoteAffordance ? '1px solid var(--text-tertiary)' : 'none',
            cursor: 'pointer',
            alignSelf: 'center',
            flexShrink: 0,
            opacity: hasFilePrivateNote || showAddFileNoteAffordance ? 1 : 0.35,
            transition: 'all var(--transition-fast)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9,
            fontWeight: 700,
            color: 'var(--accent-yellow, #f59e0b)',
            lineHeight: 1,
            padding: 0,
          }}
          onMouseEnter={() => setIsFileNoteHovered(true)}
          onMouseLeave={() => setIsFileNoteHovered(false)}
          onFocus={() => setIsFileNoteHovered(true)}
          onBlur={() => setIsFileNoteHovered(false)}
        >
          {showAddFileNoteAffordance ? '+' : ''}
        </button>
      )}
      </div>

      {canAddPrivateNotes && (isFileNoteOpen || hasFilePrivateNote) && (
        <div style={{ padding: '0 var(--space-3) var(--space-2)' }}>
          <FilePrivateNoteThread
            filePath={file.path}
            noteText={filePrivateNote}
            isComposerOpen={isFileNoteOpen}
            onSave={onSaveFilePrivateNote}
            onClear={onClearFilePrivateNote}
            onRequestOpen={() => setIsFileNoteOpen(true)}
            onRequestClose={() => setIsFileNoteOpen(false)}
          />
        </div>
      )}

      {/* Expanded diff */}
      {(feedMode || isExpanded) && (
        <div style={{
          borderTop: '1px solid var(--border-muted)',
        }}>
          <ExpandedFileDiff
            file={file}
            viewMode={viewMode}
            findingFocusLine={findingFocusLine}
            recommendations={recommendations}
            recommendationResolutions={recommendationResolutions}
            githubConversationThreads={githubConversationThreads}
            githubConversationPrAuthorLogin={githubConversationPrAuthorLogin}
            githubConversationControls={githubConversationControls}
            canCommentOnRecommendation={canCommentOnRecommendation}
            getRecommendationComment={getRecommendationComment}
            onSaveRecommendationComment={onSaveRecommendationComment}
            onClearRecommendationComment={onClearRecommendationComment}
            canAddRecommendationNotes={canAddRecommendationNotes}
            getRecommendationNote={getRecommendationNote}
            onSaveRecommendationNote={onSaveRecommendationNote}
            onClearRecommendationNote={onClearRecommendationNote}
            canCommentOnAnyLine={canCommentOnAnyLine}
            commentingUnavailableReason={commentingUnavailableReason}
            getManualLineComment={getManualLineComment}
            onSaveManualLineComment={onSaveManualLineComment}
            onClearManualLineComment={onClearManualLineComment}
            canAddPrivateNotes={canAddPrivateNotes}
            getPrivateNote={getPrivateNote}
            onSavePrivateNote={onSavePrivateNote}
            onClearPrivateNote={onClearPrivateNote}
            onAskAtlasFinding={onAskAtlasFinding}
            shouldTokenize={shouldTokenize}
          />
        </div>
      )}
    </div>
  );
}

function SummaryBucketSection({
  bucket,
  fileByPath,
  fileStatsByPath,
  isExpanded,
  onToggle,
  isFileExpanded,
  onToggleFile,
  viewMode,
  findingFocusLine,
  recommendations,
  recommendationResolutions = {},
  githubConversationThreads,
  githubConversationPrAuthorLogin,
  githubConversationControls,
  canCommentOnRecommendation,
  getRecommendationComment,
  onSaveRecommendationComment,
  onClearRecommendationComment,
  canAddRecommendationNotes,
  getRecommendationNote,
  onSaveRecommendationNote,
  onClearRecommendationNote,
  canCommentOnAnyLine,
  commentingUnavailableReason,
  getManualLineComment,
  onSaveManualLineComment,
  onClearManualLineComment,
  canAddPrivateNotes,
  getPrivateNote,
  onSavePrivateNote,
  onClearPrivateNote,
  getFilePrivateNote,
  onSaveFilePrivateNote,
  onClearFilePrivateNote,
  onAskAtlasFinding,
  onAskAtlasFile,
}: {
  bucket: ReviewFileTreeBucket;
  fileByPath: Map<string, SummaryFileEntry>;
  fileStatsByPath: Map<string, { additions: number; deletions: number }>;
  isExpanded: boolean;
  onToggle: () => void;
  isFileExpanded: (path: string) => boolean;
  onToggleFile: (path: string) => void;
  viewMode: 'unified' | 'split';
  findingFocusLine?: number | null;
  recommendations?: ReviewRecommendation[];
  recommendationResolutions?: RecommendationResolutionMap;
  githubConversationThreads?: GitHubPrReviewThread[];
  githubConversationPrAuthorLogin?: string | null;
  githubConversationControls?: GitHubConversationInlineControls;
  canCommentOnRecommendation: boolean;
  getRecommendationComment?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationComment?: (rec: ReviewRecommendation, comment: string) => void;
  onClearRecommendationComment?: (rec: ReviewRecommendation) => void;
  canAddRecommendationNotes: boolean;
  getRecommendationNote?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationNote?: (rec: ReviewRecommendation, note: string) => void;
  onClearRecommendationNote?: (rec: ReviewRecommendation) => void;
  canCommentOnAnyLine: boolean;
  commentingUnavailableReason?: string | null;
  getManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSaveManualLineComment?: (path: string, line: number, comment: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  canAddPrivateNotes: boolean;
  getPrivateNote?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSavePrivateNote?: (path: string, line: number, note: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearPrivateNote?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  getFilePrivateNote?: (path: string) => string;
  onSaveFilePrivateNote?: (path: string, note: string) => void;
  onClearFilePrivateNote?: (path: string) => void;
  onAskAtlasFinding?: (rec: ReviewRecommendation) => void;
  onAskAtlasFile?: (path: string) => void;
}) {
  return (
    <div style={{ borderTop: '1px solid var(--border-muted)', paddingTop: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: '4px 0',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          color: 'var(--text-secondary)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        <span style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform var(--transition-fast)' }}>▶</span>
        <span style={{ flex: 1, textAlign: 'left' }}>{bucket.label}</span>
        <span>{bucket.entries.length} file{bucket.entries.length === 1 ? '' : 's'}</span>
      </button>
      {isExpanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
          {bucket.entries.map((entry) => {
            const file = fileByPath.get(entry.path);
            if (!file) return null;
            return (
              <ExpandableFileRow
                key={entry.path}
                file={file}
                entry={entry}
                stats={fileStatsByPath.get(file.path)}
                isExpanded={isFileExpanded(file.path)}
                onToggle={() => onToggleFile(file.path)}
                viewMode={viewMode}
                findingFocusLine={findingFocusLine}
                recommendations={recommendations}
                recommendationResolutions={recommendationResolutions}
                githubConversationThreads={githubConversationThreads}
                githubConversationPrAuthorLogin={githubConversationPrAuthorLogin}
                githubConversationControls={githubConversationControls}
                canCommentOnRecommendation={canCommentOnRecommendation}
                getRecommendationComment={getRecommendationComment}
                onSaveRecommendationComment={onSaveRecommendationComment}
                onClearRecommendationComment={onClearRecommendationComment}
                canAddRecommendationNotes={canAddRecommendationNotes}
                getRecommendationNote={getRecommendationNote}
                onSaveRecommendationNote={onSaveRecommendationNote}
                onClearRecommendationNote={onClearRecommendationNote}
                canCommentOnAnyLine={canCommentOnAnyLine}
                commentingUnavailableReason={commentingUnavailableReason}
                getManualLineComment={getManualLineComment}
                onSaveManualLineComment={onSaveManualLineComment}
                onClearManualLineComment={onClearManualLineComment}
                canAddPrivateNotes={canAddPrivateNotes}
                getPrivateNote={getPrivateNote}
                onSavePrivateNote={onSavePrivateNote}
                onClearPrivateNote={onClearPrivateNote}
                getFilePrivateNote={getFilePrivateNote}
                onSaveFilePrivateNote={onSaveFilePrivateNote}
                onClearFilePrivateNote={onClearFilePrivateNote}
                onAskAtlasFinding={onAskAtlasFinding}
                onAskAtlasFile={onAskAtlasFile}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Expanded File Diff ─────────────────────────────────────────────────

function ExpandedFileDiff({
  file,
  viewMode,
  findingFocusLine,
  recommendations,
  recommendationResolutions = {},
  githubConversationThreads,
  githubConversationPrAuthorLogin,
  githubConversationControls,
  canCommentOnRecommendation,
  getRecommendationComment,
  onSaveRecommendationComment,
  onClearRecommendationComment,
  canAddRecommendationNotes,
  getRecommendationNote,
  onSaveRecommendationNote,
  onClearRecommendationNote,
  canCommentOnAnyLine,
  commentingUnavailableReason,
  getManualLineComment,
  onSaveManualLineComment,
  onClearManualLineComment,
  canAddPrivateNotes,
  getPrivateNote,
  onSavePrivateNote,
  onClearPrivateNote,
  onAskAtlasFinding,
  shouldTokenize = true,
}: {
  file: SummaryFileEntry;
  viewMode: 'unified' | 'split';
  findingFocusLine?: number | null;
  recommendations?: ReviewRecommendation[];
  recommendationResolutions?: RecommendationResolutionMap;
  githubConversationThreads?: GitHubPrReviewThread[];
  githubConversationPrAuthorLogin?: string | null;
  githubConversationControls?: GitHubConversationInlineControls;
  canCommentOnRecommendation: boolean;
  getRecommendationComment?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationComment?: (rec: ReviewRecommendation, comment: string) => void;
  onClearRecommendationComment?: (rec: ReviewRecommendation) => void;
  canAddRecommendationNotes: boolean;
  getRecommendationNote?: (rec: ReviewRecommendation) => string;
  onSaveRecommendationNote?: (rec: ReviewRecommendation, note: string) => void;
  onClearRecommendationNote?: (rec: ReviewRecommendation) => void;
  canCommentOnAnyLine: boolean;
  commentingUnavailableReason?: string | null;
  getManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSaveManualLineComment?: (path: string, line: number, comment: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearManualLineComment?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  canAddPrivateNotes: boolean;
  getPrivateNote?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => string;
  onSavePrivateNote?: (path: string, line: number, note: string, side?: 'LEFT' | 'RIGHT') => void;
  onClearPrivateNote?: (path: string, line: number, side?: 'LEFT' | 'RIGHT') => void;
  onAskAtlasFinding?: (rec: ReviewRecommendation) => void;
  shouldTokenize?: boolean;
}) {
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());
  const [dismissedComments, setDismissedComments] = useState<Set<string>>(new Set());
  const [collapsedComments, setCollapsedComments] = useState<Set<string>>(new Set());
  const getInlineRecommendationResolution = useCallback(
    (rec: ReviewRecommendation) => getRecommendationResolutionFor(rec, recommendationResolutions)?.state || null,
    [recommendationResolutions],
  );
  const [openLineCommentKey, setOpenLineCommentKey] = useState<string | null>(null);
  const [openPrivateNoteKey, setOpenPrivateNoteKey] = useState<string | null>(null);
  const [showCommentGuidancePulse, setShowCommentGuidancePulse] = useState(false);
  const [renderAllLines, setRenderAllLines] = useState(false);
  const showDisabledCommentControls = Boolean(commentingUnavailableReason);
  const effectiveViewMode = (viewMode === 'split' && isFileSplittable(file)) ? 'split' : 'unified';
  const commentGuidanceRef = useRef<HTMLDivElement | null>(null);
  const commentGuidancePulseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setExpandedSections(new Set());
    setRenderAllLines(false);
  }, [file.path, findingFocusLine]);

  const dismissComment = useCallback((rec: ReviewRecommendation) => {
    setDismissedComments(prev => {
      const next = new Set(prev);
      next.add(rec.recommendationKey || `${getRecommendationSourceFile(rec)}-${getRecommendationPatchLine(rec)}-${rec.title}`);
      return next;
    });
  }, []);

  const toggleCommentCollapse = useCallback((rec: ReviewRecommendation) => {
    const key = rec.recommendationKey || `${getRecommendationSourceFile(rec)}-${getRecommendationPatchLine(rec)}-${rec.title}`;
    setCollapsedComments(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const contentNotLoaded = file.contentLoaded === false;

  const isBinary = !contentNotLoaded && (
    (file.before !== null && file.before.includes('\0')) ||
    (file.after !== null && file.after.includes('\0'))
  );

  const diffLines = useMemo<DiffLine[]>(() => {
    if (contentNotLoaded || isBinary) return [];
    // For branch reviews with patches, use patch parsing
    if (typeof file.patch === 'string' && file.patch.trim()) {
      const patchLines = parseUnifiedPatchToDiffLines(file.patch);
      if (patchLines.length > 0) return patchLines;
    }
    return computeUnifiedDiff(file.before, file.after);
  }, [file.before, file.after, file.patch, isBinary, contentNotLoaded]);

  const displayLines = useMemo<DiffLineOrCollapsed[]>(() => {
    if (diffLines.length === 0) return [];
    const collapsed = findingFocusLine
      ? collapseAroundFocusLine(diffLines, findingFocusLine)
      : collapseContext(diffLines, 3);
    if (expandedSections.size === 0) return collapsed;
    const result: DiffLineOrCollapsed[] = [];
    for (const item of collapsed) {
      if (isCollapsedSection(item) && expandedSections.has((item as CollapsedSection).startIdx)) {
        const section = item as CollapsedSection;
        for (let i = section.startIdx; i < section.endIdx; i++) {
          result.push(diffLines[i]);
        }
      } else {
        result.push(item);
      }
    }
    return result;
  }, [diffLines, expandedSections, findingFocusLine]);

  const visibleDisplayLines = useMemo<DiffLineOrCollapsed[]>(() => {
    if (renderAllLines || displayLines.length <= HUGE_FILE_RENDER_CAP) return displayLines;
    return displayLines.slice(0, HUGE_FILE_RENDER_CAP);
  }, [displayLines, renderAllLines]);
  const hiddenDisplayLineCount = displayLines.length - visibleDisplayLines.length;

  const renderedLineNumbers = useMemo(() => {
    const lines = new Set<number>();
    for (const item of displayLines) {
      if (isCollapsedSection(item)) continue;
      const line = item as DiffLine;
      const newLineNumber = Number.isFinite(Number(line.newNum)) && Number(line.newNum) > 0
        ? Math.floor(Number(line.newNum))
        : null;
      const oldLineNumber = Number.isFinite(Number(line.oldNum)) && Number(line.oldNum) > 0
        ? Math.floor(Number(line.oldNum))
        : null;
      if (newLineNumber != null) lines.add(newLineNumber);
      if (oldLineNumber != null) lines.add(oldLineNumber);
    }
    return lines;
  }, [displayLines]);

  const canonicalPathLookup = useMemo(
    () => buildReviewPathLookup([
      file.path,
      (file as SummaryFileEntry & { oldPath?: string | null }).oldPath || null,
    ]),
    [file.path, (file as SummaryFileEntry & { oldPath?: string | null }).oldPath]
  );

  const rawCommentsByLine = useCommentsByLine(recommendations, file.path, renderedLineNumbers, canonicalPathLookup);
  const commentsByLine = useMemo(() => (
    findingFocusLine
      ? ensureInlineCommentPrecedingContext(rawCommentsByLine, displayLines)
      : rawCommentsByLine
  ), [displayLines, findingFocusLine, rawCommentsByLine]);
  const githubConversationsByLine = useMemo(
    () => buildGitHubConversationsByLine(githubConversationThreads, file.path, canonicalPathLookup),
    [githubConversationThreads, file.path, canonicalPathLookup]
  );

  const canonicalFilePath = useMemo(
    () => resolveCanonicalReviewPath(file.path, canonicalPathLookup) || file.path,
    [file.path, canonicalPathLookup]
  );

  const githubConversationInlineTargets = useMemo(() => {
    const targets: Array<{ thread: GitHubPrReviewThread; line: number; side: 'LEFT' | 'RIGHT' }> = [];
    const seenThreadIds = new Set<string>();
    for (const thread of githubConversationThreads || []) {
      const target = getGitHubConversationDiffTarget(thread);
      if (!target?.path || !target.line) continue;
      const canonicalThreadPath = resolveCanonicalReviewPath(target.path, canonicalPathLookup) || target.path;
      if (canonicalThreadPath !== canonicalFilePath) continue;
      const threadId = thread.id || thread.nodeId || `${target.path}:${target.side}:${target.line}`;
      if (seenThreadIds.has(threadId)) continue;
      seenThreadIds.add(threadId);
      targets.push({ thread, line: target.line, side: target.side });
    }
    return targets.sort((left, right) => (
      left.line - right.line || left.side.localeCompare(right.side)
    ));
  }, [canonicalFilePath, canonicalPathLookup, githubConversationThreads]);

  const outsidePatchRecommendations = useMemo(() => (
    (recommendations || []).filter((rec) => (
      (resolveCanonicalReviewPath(getRecommendationSourceFile(rec), canonicalPathLookup) || getRecommendationSourceFile(rec)) === canonicalFilePath
      && resolveRecommendationDisplayAnchor(rec, renderedLineNumbers)?.mode === 'source-only'
      && getRecommendationSourceLine(rec) != null
    ))
  ), [recommendations, canonicalPathLookup, canonicalFilePath, renderedLineNumbers]);

  // Build split rows when in split mode
  const splitRows = useMemo<SplitRow[]>(() => {
    if (effectiveViewMode !== 'split') return [];
    const rows: SplitRow[] = [];
    let i = 0;
    while (i < displayLines.length) {
      const item = displayLines[i];
      if (isCollapsedSection(item)) {
        rows.push({ leftLine: null, rightLine: null, collapsed: item as CollapsedSection });
        i++;
        continue;
      }
      if ((item as DiffLine).type === 'context') {
        rows.push({ leftLine: item as DiffLine, rightLine: item as DiffLine });
        i++;
        continue;
      }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < displayLines.length && !isCollapsedSection(displayLines[i]) && (displayLines[i] as DiffLine).type === 'del') {
        dels.push(displayLines[i] as DiffLine);
        i++;
      }
      while (i < displayLines.length && !isCollapsedSection(displayLines[i]) && (displayLines[i] as DiffLine).type === 'add') {
        adds.push(displayLines[i] as DiffLine);
        i++;
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        rows.push({
          leftLine: j < dels.length ? dels[j] : null,
          rightLine: j < adds.length ? adds[j] : null,
        });
      }
    }
    return rows;
  }, [displayLines, effectiveViewMode]);

  const visibleSplitRows = useMemo<SplitRow[]>(() => {
    if (renderAllLines || splitRows.length <= HUGE_FILE_RENDER_CAP) return splitRows;
    return splitRows.slice(0, HUGE_FILE_RENDER_CAP);
  }, [splitRows, renderAllLines]);
  const hiddenSplitRowCount = splitRows.length - visibleSplitRows.length;

  // Register an "ensure this line is rendered" callback so navigation
  // (scrollToFileInternal, finding-anchor jumps, GitHub conversation jumps)
  // can flip out of the huge-file render cap before scrolling. Without this,
  // a click on a finding past row HUGE_FILE_RENDER_CAP fails silently
  // because the line element isn't in the DOM yet.
  const expanderRegistry = useContext(LineExpanderRegistryContext);
  useEffect(() => {
    if (!expanderRegistry) return;
    const ensureLineRendered: LineExpander = (targetLine, side) => {
      if (renderAllLines) return;
      let index = -1;
      if (effectiveViewMode === 'split') {
        index = splitRows.findIndex((row) => {
          if (row.collapsed) return false;
          if (side === 'LEFT') return row.leftLine?.oldNum === targetLine;
          // Default to a right-or-either-side match — most navigation targets
          // come from the new (right) side.
          return row.rightLine?.newNum === targetLine
            || row.rightLine?.oldNum === targetLine
            || row.leftLine?.oldNum === targetLine;
        });
      } else {
        index = displayLines.findIndex((item) => {
          if (isCollapsedSection(item)) return false;
          const dl = item as DiffLine;
          if (side === 'LEFT') return dl.oldNum === targetLine;
          return dl.newNum === targetLine || dl.oldNum === targetLine;
        });
      }
      if (index >= HUGE_FILE_RENDER_CAP) {
        setRenderAllLines(true);
      }
    };
    expanderRegistry.set(file.path, ensureLineRendered);
    return () => {
      // Only delete our entry — a parent re-render that registered a new
      // entry under the same path would have replaced us already.
      if (expanderRegistry.get(file.path) === ensureLineRendered) {
        expanderRegistry.delete(file.path);
      }
    };
  }, [expanderRegistry, file.path, displayLines, splitRows, renderAllLines, effectiveViewMode]);

  const syntaxTokens = useSyntaxTokens(
    file.before,
    file.after,
    file.path,
    shouldTokenize,
  );

  const expandSection = useCallback((startIdx: number) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.add(startIdx);
      return next;
    });
  }, []);

  const getCollapsedNewLineRange = useCallback((section: CollapsedSection): { start: number | null; end: number | null } => {
    let start: number | null = null;
    let end: number | null = null;
    for (let i = section.startIdx; i < section.endIdx; i++) {
      const rawLine = diffLines[i]?.newNum;
      const line = Number.isFinite(Number(rawLine)) && Number(rawLine) > 0 ? Math.floor(Number(rawLine)) : null;
      if (line == null) continue;
      if (start == null || line < start) start = line;
      if (end == null || line > end) end = line;
    }
    return { start, end };
  }, [diffLines]);

  const isUnifiedHunkStart = useCallback((index: number): boolean => {
    const current = displayLines[index];
    if (!current || isCollapsedSection(current)) return false;
    const line = current as DiffLine;
    if (line.type === 'context') return false;
    if (index === 0) return true;
    const previous = displayLines[index - 1];
    if (!previous || isCollapsedSection(previous)) return true;
    return (previous as DiffLine).type === 'context';
  }, [displayLines]);

  const isSplitRowHunkStart = useCallback((index: number): boolean => {
    const row = splitRows[index];
    if (!row || row.collapsed) return false;
    const rowHasChanges = row.leftLine?.type === 'del'
      || row.leftLine?.type === 'add'
      || row.rightLine?.type === 'del'
      || row.rightLine?.type === 'add';
    if (!rowHasChanges) return false;
    if (index === 0) return true;
    const previous = splitRows[index - 1];
    if (!previous || previous.collapsed) return true;
    const previousHasChanges = previous.leftLine?.type === 'del'
      || previous.leftLine?.type === 'add'
      || previous.rightLine?.type === 'del'
      || previous.rightLine?.type === 'add';
    return !previousHasChanges;
  }, [splitRows]);

  const makeLineCommentKey = useCallback((lineNumber: number | null | undefined, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    if (!Number.isFinite(Number(lineNumber)) || Number(lineNumber) <= 0) return null;
    return `${file.path}:${side}:${Math.floor(Number(lineNumber))}`;
  }, [file.path]);
  const makePrivateNoteKey = useCallback((lineNumber: number | null | undefined, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    if (!Number.isFinite(Number(lineNumber)) || Number(lineNumber) <= 0) return null;
    return `note:${file.path}:${side}:${Math.floor(Number(lineNumber))}`;
  }, [file.path]);

  const openLineCommentComposer = useCallback((lineNumber: number | null | undefined, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    const nextKey = makeLineCommentKey(lineNumber, side);
    if (!nextKey) return;
    if (!canCommentOnAnyLine && commentingUnavailableReason) {
      commentGuidanceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setShowCommentGuidancePulse(true);
      if (commentGuidancePulseTimerRef.current != null) {
        window.clearTimeout(commentGuidancePulseTimerRef.current);
      }
      commentGuidancePulseTimerRef.current = window.setTimeout(() => {
        setShowCommentGuidancePulse(false);
        commentGuidancePulseTimerRef.current = null;
      }, 1400);
      return;
    }
    setOpenLineCommentKey(nextKey);
  }, [makeLineCommentKey, canCommentOnAnyLine, commentingUnavailableReason]);

  useEffect(() => {
    return () => {
      if (commentGuidancePulseTimerRef.current != null) {
        window.clearTimeout(commentGuidancePulseTimerRef.current);
      }
    };
  }, []);

  const closeLineCommentComposer = useCallback((lineNumber: number | null | undefined, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    const targetKey = makeLineCommentKey(lineNumber, side);
    setOpenLineCommentKey((prev) => (prev === targetKey ? null : prev));
  }, [makeLineCommentKey]);
  const openPrivateNoteComposer = useCallback((lineNumber: number | null | undefined, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    const nextKey = makePrivateNoteKey(lineNumber, side);
    if (!nextKey) return;
    setOpenPrivateNoteKey(nextKey);
  }, [makePrivateNoteKey]);
  const closePrivateNoteComposer = useCallback((lineNumber: number | null | undefined, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    const targetKey = makePrivateNoteKey(lineNumber, side);
    setOpenPrivateNoteKey((prev) => (prev === targetKey ? null : prev));
  }, [makePrivateNoteKey]);

  // Content not yet loaded — show loading indicator
  if (contentNotLoaded) {
    return (
      <div style={{
        padding: 'var(--space-3)',
        textAlign: 'center',
        color: 'var(--text-tertiary)',
        fontSize: 'var(--text-xs)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-2)',
      }}>
        <span style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          border: '2px solid var(--border-muted)',
          borderTopColor: 'var(--accent-blue)',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        Loading diff…
      </div>
    );
  }

  if (isBinary) {
    return (
      <div style={{
        padding: 'var(--space-3)',
        textAlign: 'center',
        color: 'var(--text-tertiary)',
        fontSize: 'var(--text-xs)',
      }}>
        Binary file changed
      </div>
    );
  }

  if (diffLines.length === 0) {
    if (githubConversationInlineTargets.length > 0) {
      return (
        <div style={{
          padding: 'var(--space-3)',
          color: 'var(--text-tertiary)',
          fontSize: 'var(--text-xs)',
        }}>
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-3)' }}>
            No content changes
          </div>
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            {githubConversationInlineTargets.map(({ thread, line, side }) => (
              <GitHubConversationInlineThreads
                key={thread.id || `${side}:${line}`}
                filePath={file.path}
                lineNumber={line}
                side={side}
                threads={[thread]}
                prAuthorLogin={githubConversationPrAuthorLogin}
                controls={githubConversationControls}
              />
            ))}
          </div>
        </div>
      );
    }
    return (
      <div style={{
        padding: 'var(--space-3)',
        textAlign: 'center',
        color: 'var(--text-tertiary)',
        fontSize: 'var(--text-xs)',
      }}>
        No content changes
      </div>
    );
  }

  const outsidePatchFindingsBlock = outsidePatchRecommendations.length > 0 ? (
    <div style={{
      margin: '0 0 var(--space-3)',
      padding: 'var(--space-3)',
      border: '1px solid var(--review-shell-border)',
      borderRadius: 'var(--radius-lg)',
      background: 'rgba(15, 20, 32, 0.82)',
    }}>
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        color: 'var(--text-secondary)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 'var(--space-2)',
      }}>
        Source-only findings
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {outsidePatchRecommendations.map((rec) => (
          <InlineCommentCard
            key={rec.recommendationKey || `${getRecommendationSourceFile(rec)}-${getRecommendationSourceLine(rec)}-${rec.title}`}
            rec={rec}
            mode="source-only"
            sourceLine={getRecommendationSourceLine(rec)}
            isCollapsed={false}
            resolvedAs={getInlineRecommendationResolution(rec)}
            onDismiss={() => {}}
            onToggleCollapse={() => {}}
            anchorHint={`Source line ${getRecommendationSourceLine(rec)} is attached to the source file, not a visible patch line.`}
            canComment={canCommentOnRecommendation && rec.type !== 'praise'}
            commentDisabledReason={rec.type !== 'praise' ? commentingUnavailableReason : null}
            commentText={getRecommendationComment?.(rec)}
            onSaveComment={onSaveRecommendationComment}
            onClearComment={onClearRecommendationComment}
            canAddNote={canAddRecommendationNotes && rec.type !== 'praise'}
            noteText={getRecommendationNote?.(rec)}
            onSaveNote={onSaveRecommendationNote}
            onClearNote={onClearRecommendationNote}
            onAskAgent={onAskAtlasFinding}
            hideDismiss
            hideCollapse
          />
        ))}
      </div>
    </div>
  ) : null;

  const commentGuidanceBlock = (canCommentOnAnyLine || canCommentOnRecommendation || showDisabledCommentControls) ? (
    <div
      ref={commentGuidanceRef}
      style={{
      margin: '0 0 var(--space-3)',
      padding: 'var(--space-2) var(--space-3)',
      border: showCommentGuidancePulse ? '1px solid rgba(69, 215, 246, 0.48)' : '1px solid rgba(69, 215, 246, 0.16)',
      borderRadius: 12,
      background: showCommentGuidancePulse ? 'rgba(18, 78, 96, 0.28)' : 'rgba(18, 78, 96, 0.18)',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      boxShadow: showCommentGuidancePulse ? '0 0 0 1px rgba(69, 215, 246, 0.2), 0 0 24px rgba(69, 215, 246, 0.12)' : 'none',
      transition: 'background 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
    }}>
      <div style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: '#45d7f6',
      }}>
        {showDisabledCommentControls ? 'PR comments unavailable' : 'PR comments'}
      </div>
      <div style={{
        fontSize: 11,
        color: 'var(--text-secondary-bright)',
        lineHeight: 1.45,
      }}>
        {showDisabledCommentControls
          ? 'Comments on branch reviews are disabled because they only publish to GitHub pull requests. Open or switch to a PR from this branch to comment there.'
          : <>Click a finding source link to jump to its anchor, or click a changed line number or <strong>+</strong> gutter to add a GitHub-style line comment.</>}
      </div>
    </div>
  ) : null;

  if (effectiveViewMode === 'split') {
    const emptySplitLine = (
      <div style={{
        display: 'flex',
        background: 'var(--bg-overlay)',
        minHeight: 'var(--diff-line-height)',
      }}>
        <span style={{
          width: 'var(--line-num-width)',
          minWidth: 'var(--line-num-width)',
          borderRight: '1px solid var(--border-muted)',
        }} />
        <span style={{ flex: 1 }} />
      </div>
    );

    return (
      <div>
        {commentGuidanceBlock}
        {outsidePatchFindingsBlock}
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--diff-font-size)',
          lineHeight: 'var(--diff-line-height)',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          overflow: 'visible',
        }}>
          {/* Left column (old) */}
          <div style={{ display: 'contents' }}>
            {visibleSplitRows.map((row, idx) => {
              const cellStyle = {
                gridColumn: 1,
                gridRow: idx + 1,
                minWidth: 0,
                borderRight: '1px solid var(--border-default)',
              } as const;
              if (row.collapsed) {
                const range = getCollapsedNewLineRange(row.collapsed);
                return (
                  <div key={`cl-${row.collapsed.startIdx}`} style={cellStyle}>
                    <CollapsedBar
                      section={row.collapsed}
                      onExpand={expandSection}
                      newStartLine={range.start}
                      newEndLine={range.end}
                    />
                  </div>
                );
              }
              if (!row.leftLine) return <div key={`el-${idx}`} style={cellStyle}>{emptySplitLine}</div>;
              const isHunkStart = isSplitRowHunkStart(idx) && !row.rightLine;
              const leftLineCommentKey = makeLineCommentKey(row.leftLine.oldNum, 'LEFT');
              const leftLineCommentText = row.leftLine.oldNum != null ? getManualLineComment?.(file.path, row.leftLine.oldNum, 'LEFT') : '';
              const leftHasLineComment = Boolean(leftLineCommentText?.trim());
              const leftPrivateNoteKey = makePrivateNoteKey(row.leftLine.oldNum, 'LEFT');
              const leftPrivateNoteText = row.leftLine.oldNum != null ? getPrivateNote?.(file.path, row.leftLine.oldNum, 'LEFT') : '';
              const leftHasPrivateNote = Boolean(leftPrivateNoteText?.trim());
              const leftGithubThreads = githubConversationsByLine.get(makeGitHubConversationLineKey(row.leftLine.oldNum, 'LEFT') || '') || [];
              return (
                <div
                  key={`l-${idx}`}
                  style={cellStyle}
                  data-review-hunk-anchor={isHunkStart ? 'true' : undefined}
                  data-review-hunk-file={isHunkStart ? file.path : undefined}
                  data-review-hunk-line={isHunkStart ? (row.leftLine.oldNum ?? undefined) : undefined}
                >
                  <SplitDiffLine
                    line={row.leftLine}
                    side="left"
                    syntaxTokens={syntaxTokens}
                    selectionMeta={{
                      path: file.path,
                      side: 'LEFT',
                      lineNumber: row.leftLine.oldNum,
                    }}
                    commentControl={{
                      enabled: canCommentOnAnyLine && row.leftLine.oldNum != null && row.leftLine.type === 'del',
                      visible: row.leftLine.oldNum != null && row.leftLine.type === 'del' && (canCommentOnAnyLine || showDisabledCommentControls),
                      active: openLineCommentKey === leftLineCommentKey,
                      hasComment: leftHasLineComment,
                      disabledReason: row.leftLine.oldNum != null && row.leftLine.type === 'del' && !canCommentOnAnyLine
                        ? (commentingUnavailableReason || undefined)
                        : undefined,
                      onClick: () => openLineCommentComposer(row.leftLine?.oldNum, 'LEFT'),
                    }}
                    noteControl={{
                      enabled: canAddPrivateNotes && row.leftLine.oldNum != null && row.leftLine.type === 'del',
                      visible: row.leftLine.oldNum != null && row.leftLine.type === 'del' && canAddPrivateNotes,
                      active: openPrivateNoteKey === leftPrivateNoteKey,
                      hasComment: leftHasPrivateNote,
                      onClick: () => openPrivateNoteComposer(row.leftLine?.oldNum, 'LEFT'),
                    }}
                  />
                  <ManualLineCommentThread
                    filePath={file.path}
                    lineNumber={row.leftLine.oldNum}
                    side="LEFT"
                    canComment={canCommentOnAnyLine && row.leftLine.type === 'del'}
                    isComposerOpen={openLineCommentKey === leftLineCommentKey}
                    commentText={leftLineCommentText}
                    onSave={onSaveManualLineComment}
                    onClear={onClearManualLineComment}
                    onRequestOpen={() => openLineCommentComposer(row.leftLine?.oldNum, 'LEFT')}
                    onRequestClose={() => closeLineCommentComposer(row.leftLine?.oldNum, 'LEFT')}
                  />
                  <PrivateLineNoteThread
                    filePath={file.path}
                    lineNumber={row.leftLine.oldNum}
                    side="LEFT"
                    isComposerOpen={openPrivateNoteKey === leftPrivateNoteKey}
                    noteText={leftPrivateNoteText}
                    onSave={onSavePrivateNote}
                    onClear={onClearPrivateNote}
                    onRequestOpen={() => openPrivateNoteComposer(row.leftLine?.oldNum, 'LEFT')}
                    onRequestClose={() => closePrivateNoteComposer(row.leftLine?.oldNum, 'LEFT')}
                  />
                  <GitHubConversationInlineThreads
                    filePath={file.path}
                    lineNumber={row.leftLine.oldNum}
                    side="LEFT"
                    threads={leftGithubThreads}
                    prAuthorLogin={githubConversationPrAuthorLogin}
                    controls={githubConversationControls}
                  />
                </div>
              );
            })}
          </div>
          {/* Right column (new) */}
          <div style={{ display: 'contents' }}>
            {visibleSplitRows.map((row, idx) => {
              const cellStyle = {
                gridColumn: 2,
                gridRow: idx + 1,
                minWidth: 0,
              } as const;
              if (row.collapsed) {
                const range = getCollapsedNewLineRange(row.collapsed);
                return (
                  <div key={`cr-${row.collapsed.startIdx}`} style={cellStyle}>
                    <CollapsedBar
                      section={row.collapsed}
                      onExpand={expandSection}
                      newStartLine={range.start}
                      newEndLine={range.end}
                    />
                  </div>
                );
              }
              if (!row.rightLine) return <div key={`er-${idx}`} style={cellStyle}>{emptySplitLine}</div>;
              const isHunkStart = isSplitRowHunkStart(idx);
              const lineCommentKey = makeLineCommentKey(row.rightLine.newNum, 'RIGHT');
              const lineCommentText = row.rightLine.newNum != null ? getManualLineComment?.(file.path, row.rightLine.newNum, 'RIGHT') : '';
              const hasLineComment = Boolean(lineCommentText?.trim());
              const privateNoteKey = makePrivateNoteKey(row.rightLine.newNum, 'RIGHT');
              const privateNoteText = row.rightLine.newNum != null ? getPrivateNote?.(file.path, row.rightLine.newNum, 'RIGHT') : '';
              const hasPrivateNote = Boolean(privateNoteText?.trim());
              const githubThreads = githubConversationsByLine.get(makeGitHubConversationLineKey(row.rightLine.newNum, 'RIGHT') || '') || [];
              return (
                <div
                  key={`r-${idx}`}
                  style={cellStyle}
                  data-review-hunk-anchor={isHunkStart ? 'true' : undefined}
                  data-review-hunk-file={isHunkStart ? file.path : undefined}
                  data-review-hunk-line={isHunkStart ? (row.rightLine.newNum ?? undefined) : undefined}
                >
                  <SplitDiffLine
                    line={row.rightLine}
                    side="right"
                    syntaxTokens={syntaxTokens}
                    selectionMeta={{
                      path: file.path,
                      side: 'RIGHT',
                      lineNumber: row.rightLine.newNum,
                    }}
                    commentControl={{
                      enabled: canCommentOnAnyLine && row.rightLine.newNum != null,
                      visible: row.rightLine.newNum != null && (canCommentOnAnyLine || showDisabledCommentControls),
                      active: openLineCommentKey === lineCommentKey,
                      hasComment: hasLineComment,
                      disabledReason: row.rightLine.newNum != null && !canCommentOnAnyLine
                        ? (commentingUnavailableReason || undefined)
                        : undefined,
                      onClick: () => openLineCommentComposer(row.rightLine?.newNum, 'RIGHT'),
                    }}
                    noteControl={{
                      enabled: canAddPrivateNotes && row.rightLine.newNum != null,
                      visible: row.rightLine.newNum != null && canAddPrivateNotes,
                      active: openPrivateNoteKey === privateNoteKey,
                      hasComment: hasPrivateNote,
                      onClick: () => openPrivateNoteComposer(row.rightLine?.newNum, 'RIGHT'),
                    }}
                  />
                  <ManualLineCommentThread
                    filePath={file.path}
                    lineNumber={row.rightLine.newNum}
                    side="RIGHT"
                    canComment={canCommentOnAnyLine}
                    isComposerOpen={openLineCommentKey === lineCommentKey}
                    commentText={lineCommentText}
                    onSave={onSaveManualLineComment}
                    onClear={onClearManualLineComment}
                    onRequestOpen={() => openLineCommentComposer(row.rightLine?.newNum, 'RIGHT')}
                    onRequestClose={() => closeLineCommentComposer(row.rightLine?.newNum, 'RIGHT')}
                  />
                  <PrivateLineNoteThread
                    filePath={file.path}
                    lineNumber={row.rightLine.newNum}
                    side="RIGHT"
                    isComposerOpen={openPrivateNoteKey === privateNoteKey}
                    noteText={privateNoteText}
                    onSave={onSavePrivateNote}
                    onClear={onClearPrivateNote}
                    onRequestOpen={() => openPrivateNoteComposer(row.rightLine?.newNum, 'RIGHT')}
                    onRequestClose={() => closePrivateNoteComposer(row.rightLine?.newNum, 'RIGHT')}
                  />
                  <GitHubConversationInlineThreads
                    filePath={file.path}
                    lineNumber={row.rightLine.newNum}
                    side="RIGHT"
                    threads={githubThreads}
                    prAuthorLogin={githubConversationPrAuthorLogin}
                    controls={githubConversationControls}
                  />
                  {commentsByLine.size > 0 && (
                    <InlineComments
                      line={row.rightLine}
                      commentsByLine={commentsByLine}
                      dismissedComments={dismissedComments}
                      collapsedComments={collapsedComments}
                      getResolution={getInlineRecommendationResolution}
                      canComment={canCommentOnRecommendation}
                      commentDisabledReason={commentingUnavailableReason}
                      getComment={getRecommendationComment}
                      onSaveComment={onSaveRecommendationComment}
                      onClearComment={onClearRecommendationComment}
                      canAddNote={canAddRecommendationNotes}
                      getNote={getRecommendationNote}
                      onSaveNote={onSaveRecommendationNote}
                      onClearNote={onClearRecommendationNote}
                      onDismiss={dismissComment}
                      onToggleCollapse={toggleCommentCollapse}
                      onAskAgent={onAskAtlasFinding}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {hiddenSplitRowCount > 0 && (
          <RenderRemainingLinesButton
            hiddenCount={hiddenSplitRowCount}
            onShow={() => setRenderAllLines(true)}
          />
        )}
      </div>
    );
  }

  return (
    <div>
      {commentGuidanceBlock}
      {outsidePatchFindingsBlock}
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--diff-font-size)',
        lineHeight: 'var(--diff-line-height)',
        overflowX: 'visible',
        overflowY: 'visible',
      }}>
        {visibleDisplayLines.map((item, idx) => {
          if (isCollapsedSection(item)) {
            const range = getCollapsedNewLineRange(item as CollapsedSection);
            return (
              <CollapsedBar
                key={`collapsed-${(item as CollapsedSection).startIdx}`}
                section={item as CollapsedSection}
                onExpand={expandSection}
                newStartLine={range.start}
                newEndLine={range.end}
              />
            );
          }
          const line = item as DiffLine;
          const lineCommentSide: 'LEFT' | 'RIGHT' = line.type === 'del' ? 'LEFT' : 'RIGHT';
          const lineCommentNumber = lineCommentSide === 'LEFT' ? line.oldNum : line.newNum;
          const lineCommentKey = makeLineCommentKey(lineCommentNumber, lineCommentSide);
          const lineCommentText = lineCommentNumber != null ? getManualLineComment?.(file.path, lineCommentNumber, lineCommentSide) : '';
          const hasLineComment = Boolean(lineCommentText?.trim());
          const privateNoteKey = makePrivateNoteKey(lineCommentNumber, lineCommentSide);
          const privateNoteText = lineCommentNumber != null ? getPrivateNote?.(file.path, lineCommentNumber, lineCommentSide) : '';
          const hasPrivateNote = Boolean(privateNoteText?.trim());
          const githubThreads = githubConversationsByLine.get(makeGitHubConversationLineKey(lineCommentNumber, lineCommentSide) || '') || [];
          const isHunkStart = isUnifiedHunkStart(idx);
          return (
            <div
              key={idx}
              data-review-hunk-anchor={isHunkStart ? 'true' : undefined}
              data-review-hunk-file={isHunkStart ? file.path : undefined}
              data-review-hunk-line={isHunkStart ? (lineCommentNumber ?? undefined) : undefined}
            >
              <UnifiedDiffLine
                line={line}
                syntaxTokens={syntaxTokens}
                selectionMeta={{
                  path: file.path,
                  side: lineCommentSide,
                  lineNumber: lineCommentNumber,
                }}
                commentControl={{
                  enabled: canCommentOnAnyLine && lineCommentNumber != null,
                  visible: lineCommentNumber != null && (canCommentOnAnyLine || showDisabledCommentControls),
                  active: openLineCommentKey === lineCommentKey,
                  hasComment: hasLineComment,
                  disabledReason: lineCommentNumber != null && !canCommentOnAnyLine
                    ? (commentingUnavailableReason || undefined)
                    : undefined,
                  onClick: () => openLineCommentComposer(lineCommentNumber, lineCommentSide),
                }}
                noteControl={{
                  enabled: canAddPrivateNotes && lineCommentNumber != null,
                  visible: lineCommentNumber != null && canAddPrivateNotes,
                  active: openPrivateNoteKey === privateNoteKey,
                  hasComment: hasPrivateNote,
                  onClick: () => openPrivateNoteComposer(lineCommentNumber, lineCommentSide),
                }}
              />
              <ManualLineCommentThread
                filePath={file.path}
                lineNumber={lineCommentNumber}
                side={lineCommentSide}
                canComment={canCommentOnAnyLine}
                isComposerOpen={openLineCommentKey === lineCommentKey}
                commentText={lineCommentText}
                onSave={onSaveManualLineComment}
                onClear={onClearManualLineComment}
                onRequestOpen={() => openLineCommentComposer(lineCommentNumber, lineCommentSide)}
                onRequestClose={() => closeLineCommentComposer(lineCommentNumber, lineCommentSide)}
              />
              <PrivateLineNoteThread
                filePath={file.path}
                lineNumber={lineCommentNumber}
                side={lineCommentSide}
                isComposerOpen={openPrivateNoteKey === privateNoteKey}
                noteText={privateNoteText}
                onSave={onSavePrivateNote}
                onClear={onClearPrivateNote}
                onRequestOpen={() => openPrivateNoteComposer(lineCommentNumber, lineCommentSide)}
                onRequestClose={() => closePrivateNoteComposer(lineCommentNumber, lineCommentSide)}
              />
              <GitHubConversationInlineThreads
                filePath={file.path}
                lineNumber={lineCommentNumber}
                side={lineCommentSide}
                threads={githubThreads}
                prAuthorLogin={githubConversationPrAuthorLogin}
                controls={githubConversationControls}
              />
              {commentsByLine.size > 0 && (
                <InlineComments
                  line={line}
                  commentsByLine={commentsByLine}
                  dismissedComments={dismissedComments}
                  collapsedComments={collapsedComments}
                  getResolution={getInlineRecommendationResolution}
                  canComment={canCommentOnRecommendation}
                  commentDisabledReason={commentingUnavailableReason}
                  getComment={getRecommendationComment}
                  onSaveComment={onSaveRecommendationComment}
                  onClearComment={onClearRecommendationComment}
                  canAddNote={canAddRecommendationNotes}
                  getNote={getRecommendationNote}
                  onSaveNote={onSaveRecommendationNote}
                  onClearNote={onClearRecommendationNote}
                  onDismiss={dismissComment}
                  onToggleCollapse={toggleCommentCollapse}
                  onAskAgent={onAskAtlasFinding}
                />
              )}
            </div>
          );
        })}
        {hiddenDisplayLineCount > 0 && (
          <RenderRemainingLinesButton
            hiddenCount={hiddenDisplayLineCount}
            onShow={() => setRenderAllLines(true)}
          />
        )}
      </div>
    </div>
  );
}

function RenderRemainingLinesButton({
  hiddenCount,
  onShow,
}: {
  hiddenCount: number;
  onShow: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onShow}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        width: '100%',
        minHeight: 36,
        padding: '8px 12px',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--review-toolbar-bg) 88%, var(--accent-blue) 12%), var(--review-toolbar-bg))',
        border: 'none',
        borderTop: '1px solid var(--review-shell-divider)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans, inherit)',
        fontSize: 12,
        fontWeight: 650,
        letterSpacing: 0.2,
        cursor: 'pointer',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'color-mix(in srgb, var(--review-toolbar-bg) 70%, var(--accent-blue) 30%)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'linear-gradient(180deg, color-mix(in srgb, var(--review-toolbar-bg) 88%, var(--accent-blue) 12%), var(--review-toolbar-bg))';
      }}
    >
      <span aria-hidden="true" style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: 'var(--accent-blue)',
        boxShadow: '0 0 10px color-mix(in srgb, var(--accent-blue) 44%, transparent)',
      }} />
      <span>Show remaining {hiddenCount.toLocaleString()} lines</span>
      <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
        — large file, capped for performance
      </span>
    </button>
  );
}
