/**
 * TrustDiffViewer — Center panel real diff viewer for the Trust Pipeline.
 * Replaces TrustDiffPlaceholder with proper Myers diff, intraline word
 * highlighting, context collapsing, and dual line numbers.
 *
 * Uses diff utilities from @/utils/diff (computeUnifiedDiff, collapseContext).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import toast from '@/lib/toast';
import { changesetApi, branchReviewApi, workspaceReviewApi, prReviewApi, reviewApi } from '@/services/api';
import { subscribeProjectSocket } from '@/services/projectSocket';
import { computeUnifiedDiff } from '@/utils/diff';
import { SummaryDiffView } from '@/components/review/SummaryDiffView';
import { usePopup } from '@/components/shared/PopupProvider';
import type { ReviewSummaryData, SummaryFileEntry, SummaryDiffViewRef } from '@/components/review/SummaryDiffView';
import type { ReviewAgentAttachment } from '@/services/reviewAgentApi';
import type { DiffNavigationTarget } from '@/utils/reviewNavigation';
import type { ReviewFileFilter } from '@/types';
import { getReviewActionButtonStyle, reviewSurfaceStyle } from '@/components/review/ReviewChrome';
import {
  buildReviewFileTree,
  buildRecommendationCommentStorageKey,
  buildManualLineCommentStorageKey,
  buildRecommendationOutcomeScope,
  buildRecommendationResolutionStorageKey,
  buildRecommendationNoteStorageKey,
  buildRecommendationNoteDraft,
  getReviewDiffRecommendations,
  flattenReviewFileTreeEntriesByFolder,
  getRecommendationFingerprint,
  getReviewFileTreeVisibleState,
  REVIEW_COMMENT_DRAFTS_UPDATED_EVENT,
  normalizeRecommendationCommentMap,
  normalizeManualLineCommentMap,
  normalizeRecommendationResolutionMap,
  reconcileRecommendationResolutionMaps,
  normalizeRecommendationNoteMap,
  type RecommendationResolutionMap,
} from '@/components/review/reviewPanelUtils';
import type {
  ChangeSet,
  ChangeSetFileChange,
  BranchReviewFileSummary,
  BranchReviewFileContent,
  ReviewRecommendation,
  PrReview,
  ReviewDiffManifestSummary,
  GitHubPrConversations,
  GitHubPrReviewThread,
  GitHubPrThreadComment,
} from '@/types';
import type { RecommendationCommentMap, ManualLineCommentMap, RecommendationNoteMap, ReviewCommentDraftsUpdatedDetail } from '@/components/review/reviewPanelUtils';
import {
  PR_REVIEW_CONVERSATIONS_UPDATED_EVENT,
  type PrReviewConversationsUpdatedDetail,
} from '@/components/review/GitHubConversation';

// ── Props ──────────────────────────────────────────────────────────────

export interface TrustDiffViewerProps {
  projectId: string;
  changesetId?: string;           // For change sets
  branchReviewId?: string;        // For branch reviews
  workspaceReviewId?: string;     // For workspace reviews
  prReviewId?: string;            // For PR reviews
  branchReviewRefreshToken?: number;
  fileFilterPaths?: string[] | null;
  fileFilterLabel?: string | null;
  activeFileFilter?: ReviewFileFilter | null;
  onSelectFileFilter?: (filter: ReviewFileFilter | null) => void;
  onClearFileFilter?: () => void;
  onBranchReviewSnapshotChange?: (snapshot: BranchReviewSnapshot | null) => void;
  presentationMode?: 'accordion' | 'files-feed';
  onActiveFileChange?: (path: string) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  onAskAtlasSelection?: (payload: {
    attachment: Extract<ReviewAgentAttachment, { type: 'line_range' }>;
    prompt: string;
  }) => void;
  onAskAtlasFinding?: (rec: ReviewRecommendation) => void;
  onAskAtlasFile?: (path: string) => void;
  onAskAtlasGitHubThread?: (thread: GitHubPrReviewThread) => void;
  /** Callback: right panel can call this to switch file in diff viewer */
  onScrollToFileRef?: React.MutableRefObject<((target: DiffNavigationTarget) => void) | null>;
  /** Override for the backend's default visible-file cap (200). Increases
   *  via FileTreeList's "Show 50 more files" footer; reset on review change. */
  visibleFileLimit?: number;
}

export interface BranchReviewSnapshot {
  id: string;
  branchName: string;
  baseBranch: string;
  headSha: string | null;
  commitCount: number;
  fileCount: number;
  updatedAt: string | null;
}
export type { DiffNavigationTarget } from '@/utils/reviewNavigation';

export function getEmptyReviewDiffMessage(options: {
  isPrMode: boolean;
  branchReviewSnapshot: BranchReviewSnapshot | null;
}): string {
  if (options.isPrMode) {
    return 'No changed files in this pull request yet.';
  }
  const branchName = options.branchReviewSnapshot?.branchName || 'this branch';
  const baseBranch = options.branchReviewSnapshot?.baseBranch || 'its base branch';
  return `No changed files on this branch yet. Atlas is tracking ${branchName} against ${baseBranch} and will populate the diff automatically when commits land.`;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Compute per-file stats: additions and deletions */
function fileStats(file: ChangeSetFileChange): { additions: number; deletions: number } {
  const lines = computeUnifiedDiff(file.before, file.after);
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === 'add') additions++;
    if (line.type === 'del') deletions++;
  }
  return { additions, deletions };
}

function isRenamedBranchFile(file: BranchReviewDiffFile | null | undefined): boolean {
  if (!file) return false;
  const status = String(file.status || '').toUpperCase();
  return status === 'R' || Boolean(file.oldPath && file.oldPath !== file.path);
}

function normalizeNavigationTarget(target: DiffNavigationTarget): {
  filePath: string;
  line: number | null;
  side: 'LEFT' | 'RIGHT' | null;
  suppressNearestDiffToast: boolean;
} | null {
  if (typeof target === 'string') {
    const filePath = target.trim();
    return filePath ? { filePath, line: null, side: null, suppressNearestDiffToast: false } : null;
  }
  if (!target || typeof target !== 'object') return null;
  const filePath = String(target.filePath || '').trim();
  if (!filePath) return null;
  const line = Number.isFinite(Number(target.line)) && Number(target.line) > 0
    ? Math.floor(Number(target.line))
    : null;
  const side = target.side === 'LEFT' || target.side === 'RIGHT' ? target.side : null;
  return { filePath, line, side, suppressNearestDiffToast: Boolean(target.suppressNearestDiffToast) };
}

// Category helpers

// ── View mode type ─────────────────────────────────────────────────────

type ViewMode = 'unified' | 'split';

type ReviewOutcomeSocketEvent = {
  projectId?: string;
  reviewType?: string;
  reviewId?: string;
};

type BranchReviewDiffFile = {
  path: string;
  language: string;
  additions: number;
  deletions: number;
  status: string;
  oldPath: string | null;
  before: string | null;
  after: string | null;
  patch: string | null;
  contentLoaded: boolean;
  contentLoading: boolean;
  contentError: string | null;
};

const BR_PREFETCH_BATCH_SIZE = 6;
const BR_MAX_LOADED_FILES = 24;
const FILES_FEED_LOAD_BATCH_SIZE = 10;
const FILES_FEED_PREFETCH_AFTER_COUNT = 8;
const FILES_FEED_MAX_LOADED_FILES = 36;

// ── Main Component ─────────────────────────────────────────────────────

function TrustDiffViewer({
  projectId,
  changesetId,
  branchReviewId,
  workspaceReviewId,
  prReviewId,
  branchReviewRefreshToken = 0,
  fileFilterPaths = null,
  fileFilterLabel = null,
  activeFileFilter = null,
  onSelectFileFilter,
  onClearFileFilter,
  onBranchReviewSnapshotChange,
  presentationMode = 'accordion',
  onActiveFileChange,
  viewMode: controlledViewMode,
  onViewModeChange,
  onAskAtlasSelection,
  onAskAtlasFinding,
  onAskAtlasFile,
  onAskAtlasGitHubThread,
  onScrollToFileRef,
  visibleFileLimit,
}: TrustDiffViewerProps) {
  const popup = usePopup();
  /** Whether we're in branch/PR review mode (lazy file loading) vs changeset mode */
  const isBrMode = !!branchReviewId || !!workspaceReviewId || !!prReviewId;
  const isFilesFeedMode = presentationMode === 'files-feed';
  const branchCommentUnavailableReason = !prReviewId && (branchReviewId || workspaceReviewId)
    ? 'Comments on branch reviews are disabled because they only publish to GitHub pull requests. Open or switch to a PR from this branch to comment there.'
    : null;

  const [changeset, setChangeset] = useState<ChangeSet | null>(null);
  /** For branch/PR reviews, we store files and review data separately */
  const [brFiles, setBrFiles] = useState<BranchReviewDiffFile[]>([]);
  const [brReviewData, setBrReviewData] = useState<any>(null);
  const [branchReviewSnapshot, setBranchReviewSnapshot] = useState<BranchReviewSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingAllFiles, setIsLoadingAllFiles] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [uncontrolledViewMode, setUncontrolledViewMode] = useState<ViewMode>('unified');
  const viewMode = controlledViewMode || uncontrolledViewMode;
  const setViewMode = useCallback((mode: ViewMode) => {
    if (!controlledViewMode) {
      setUncontrolledViewMode(mode);
    }
    onViewModeChange?.(mode);
  }, [controlledViewMode, onViewModeChange]);
  const [summaryReviewData, setSummaryReviewData] = useState<ReviewSummaryData | null>(null);
  const [isLoadingSummaryReview, setIsLoadingSummaryReview] = useState(false);
  const [brCommitMessages, setBrCommitMessages] = useState<string[]>([]);
  const [prBodyText, setPrBodyText] = useState<string | null>(null);
  const [diffManifestSummary, setDiffManifestSummary] = useState<ReviewDiffManifestSummary | null>(null);
  const [recommendationComments, setRecommendationComments] = useState<RecommendationCommentMap>({});
  const [manualLineComments, setManualLineComments] = useState<ManualLineCommentMap>({});
  const [recommendationResolutions, setRecommendationResolutions] = useState<RecommendationResolutionMap>({});
  const [recommendationNotes, setRecommendationNotes] = useState<RecommendationNoteMap>({});
  const [githubConversationThreads, setGithubConversationThreads] = useState<GitHubPrReviewThread[]>([]);
  const [githubConversationActionThreadId, setGithubConversationActionThreadId] = useState<string | null>(null);
  const [githubConversationActionCommentId, setGithubConversationActionCommentId] = useState<string | null>(null);
  const [hydratedRecommendationCommentStorageKey, setHydratedRecommendationCommentStorageKey] = useState<string | null>(null);
  const [hydratedManualLineCommentStorageKey, setHydratedManualLineCommentStorageKey] = useState<string | null>(null);
  const [prReviewMeta, setPrReviewMeta] = useState<Pick<PrReview, 'id' | 'githubPrNumber' | 'title' | 'displayId' | 'htmlUrl' | 'authorLogin'> | null>(null);
  const [filesFeedViewportPaths, setFilesFeedViewportPaths] = useState<string[]>([]);
  const [isDiffPaneHovered, setIsDiffPaneHovered] = useState(false);

  const requestIdRef = useRef(0);
  const diffRootRef = useRef<HTMLDivElement | null>(null);
  const activeFilePathRef = useRef<string | null>(null);
  const activeFileIndexRef = useRef(0);
  const pendingNavigationAfterFilterClearRef = useRef<DiffNavigationTarget | null>(null);
  const pendingNavigationUntilFilesReadyRef = useRef<DiffNavigationTarget | null>(null);
  const summaryReviewFetchedRef = useRef<string | null>(null);
  const summaryDiffViewRef = useRef<SummaryDiffViewRef>(null);
  const commentDraftSyncSourceIdRef = useRef(`trust-diff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const summaryTreeSourceCacheRef = useRef<{
    key: string;
    files: Array<{
      path: string;
      additions?: number | null;
      deletions?: number | null;
      status?: string | null;
      oldPath?: string | null;
    }>;
  }>({ key: '', files: [] });
  const recommendationCommentStorageKey = useMemo(() => (
    prReviewId
      ? buildRecommendationCommentStorageKey({
          projectId,
          prReviewId,
        })
      : null
  ), [projectId, prReviewId]);
  const manualLineCommentStorageKey = useMemo(() => (
    prReviewId
      ? buildManualLineCommentStorageKey({
          projectId,
          prReviewId,
        })
      : null
  ), [projectId, prReviewId]);
  const recommendationOutcomeScope = useMemo(() => buildRecommendationOutcomeScope({
    changesetId,
    branchReviewId,
    workspaceReviewId,
    prReviewId,
  }), [changesetId, branchReviewId, workspaceReviewId, prReviewId]);
  const recommendationResolutionStorageKey = useMemo(() => buildRecommendationResolutionStorageKey({
    projectId,
    changesetId,
    branchReviewId,
    workspaceReviewId,
    prReviewId,
  }), [projectId, changesetId, branchReviewId, workspaceReviewId, prReviewId]);
  const recommendationNoteStorageKey = useMemo(() => (
    buildRecommendationNoteStorageKey({
      projectId,
      branchReviewId,
      workspaceReviewId,
      branchName: branchReviewSnapshot?.branchName || null,
      prReviewId,
    })
  ), [projectId, branchReviewId, workspaceReviewId, branchReviewSnapshot?.branchName, prReviewId]);

  useEffect(() => {
    if (!recommendationResolutionStorageKey) {
      setRecommendationResolutions({});
      return;
    }
    try {
      const raw = localStorage.getItem(recommendationResolutionStorageKey);
      setRecommendationResolutions(raw ? normalizeRecommendationResolutionMap(JSON.parse(raw)) : {});
    } catch {
      setRecommendationResolutions({});
    }
  }, [recommendationResolutionStorageKey]);

  const refreshRecommendationOutcomes = useCallback(async () => {
    if (!recommendationOutcomeScope) return;
    try {
      const response = await reviewApi.getOutcomes(projectId, recommendationOutcomeScope);
      const serverMap = normalizeRecommendationResolutionMap(response.byRecommendationKey);
      setRecommendationResolutions((prev) => reconcileRecommendationResolutionMaps(prev, serverMap));
    } catch (error) {
      console.warn('Failed to hydrate inline recommendation outcomes:', error);
    }
  }, [projectId, recommendationOutcomeScope]);

  useEffect(() => {
    if (!recommendationOutcomeScope) return;
    void refreshRecommendationOutcomes();
  }, [recommendationOutcomeScope, refreshRecommendationOutcomes]);

  useEffect(() => {
    if (!projectId || !recommendationOutcomeScope) return;
    return subscribeProjectSocket(projectId, {
      'review-outcomes-updated': (payload?: ReviewOutcomeSocketEvent) => {
        if (!payload) return;
        if (payload.projectId !== projectId) return;
        if (payload.reviewType !== recommendationOutcomeScope.reviewType) return;
        if (payload.reviewId !== recommendationOutcomeScope.reviewId) return;
        void refreshRecommendationOutcomes();
      },
    });
  }, [
    projectId,
    recommendationOutcomeScope,
    refreshRecommendationOutcomes,
  ]);

  const publishGithubConversations = useCallback((conversations: GitHubPrConversations | null) => {
    setGithubConversationThreads(conversations?.threads || []);
    if (!prReviewId) return;
    window.dispatchEvent(new CustomEvent<PrReviewConversationsUpdatedDetail>(PR_REVIEW_CONVERSATIONS_UPDATED_EVENT, {
      detail: { projectId, prReviewId, conversations },
    }));
  }, [projectId, prReviewId]);

  useEffect(() => {
    if (!prReviewId) {
      setGithubConversationThreads([]);
      return;
    }

    let cancelled = false;
    void prReviewApi.getConversations(projectId, prReviewId)
      .then((response) => {
        if (cancelled) return;
        setGithubConversationThreads(response.conversations.threads || []);
        if (!response.conversations.summary.syncedAt) {
          void prReviewApi.syncConversations(projectId, prReviewId)
            .then((syncResponse) => {
              if (cancelled) return;
              publishGithubConversations(syncResponse.conversations);
            })
            .catch((error) => {
              console.warn('Failed to sync GitHub PR conversations for inline diff:', error);
            });
        }
      })
      .catch((error) => {
        console.warn('Failed to load GitHub PR conversations for inline diff:', error);
        if (!cancelled) setGithubConversationThreads([]);
      });

    const handleConversationsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<PrReviewConversationsUpdatedDetail>).detail;
      if (!detail || detail.projectId !== projectId || detail.prReviewId !== prReviewId) return;
      const conversations = detail.conversations as GitHubPrConversations | null;
      setGithubConversationThreads(conversations?.threads || []);
    };

    window.addEventListener(PR_REVIEW_CONVERSATIONS_UPDATED_EVENT, handleConversationsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(PR_REVIEW_CONVERSATIONS_UPDATED_EVENT, handleConversationsUpdated);
    };
  }, [projectId, prReviewId, publishGithubConversations]);

  const handleReplyToGitHubConversation = useCallback(async (thread: GitHubPrReviewThread, body: string) => {
    if (!prReviewId) return;
    const threadNodeId = thread.nodeId || thread.id;
    setGithubConversationActionThreadId(thread.id);
    try {
      const response = await prReviewApi.replyToConversationThread(projectId, prReviewId, threadNodeId, body);
      publishGithubConversations(response.conversations);
      toast.success('Replied to GitHub conversation');
    } catch (error: any) {
      const message = error?.response?.data?.error || error?.message || 'Failed to reply to GitHub conversation';
      toast.error(message);
      throw new Error(message);
    } finally {
      setGithubConversationActionThreadId(null);
    }
  }, [projectId, prReviewId, publishGithubConversations]);

  const handleSetGitHubConversationResolved = useCallback(async (
    thread: GitHubPrReviewThread,
    resolved: boolean,
  ) => {
    if (!prReviewId) return;
    const threadNodeId = thread.nodeId || thread.id;
    setGithubConversationActionThreadId(thread.id);
    try {
      const response = await prReviewApi.setConversationThreadResolution(projectId, prReviewId, threadNodeId, resolved);
      publishGithubConversations(response.conversations);
      toast.success(resolved ? 'Resolved GitHub conversation' : 'Reopened GitHub conversation');
    } catch (error: any) {
      const message = error?.response?.data?.error || error?.message || 'Failed to update GitHub conversation';
      toast.error(message);
      throw new Error(message);
    } finally {
      setGithubConversationActionThreadId(null);
    }
  }, [projectId, prReviewId, publishGithubConversations]);

  const handleUpdateGitHubConversationComment = useCallback(async (
    comment: GitHubPrThreadComment,
    body: string,
  ) => {
    if (!prReviewId) return;
    const commentNodeId = comment.nodeId || comment.id;
    setGithubConversationActionCommentId(comment.id);
    try {
      const response = await prReviewApi.updateConversationComment(projectId, prReviewId, commentNodeId, body);
      publishGithubConversations(response.conversations);
      toast.success('Updated GitHub comment');
    } catch (error: any) {
      const message = error?.response?.data?.error || error?.message || 'Failed to update GitHub comment';
      toast.error(message);
      throw new Error(message);
    } finally {
      setGithubConversationActionCommentId(null);
    }
  }, [projectId, prReviewId, publishGithubConversations]);

  const handleDeleteGitHubConversationComment = useCallback(async (comment: GitHubPrThreadComment) => {
    if (!prReviewId) return;
    const commentNodeId = comment.nodeId || comment.id;
    setGithubConversationActionCommentId(comment.id);
    try {
      const response = await prReviewApi.deleteConversationComment(projectId, prReviewId, commentNodeId);
      publishGithubConversations(response.conversations);
      toast.success('Deleted GitHub comment');
    } catch (error: any) {
      const message = error?.response?.data?.error || error?.message || 'Failed to delete GitHub comment';
      toast.error(message);
      throw new Error(message);
    } finally {
      setGithubConversationActionCommentId(null);
    }
  }, [projectId, prReviewId, publishGithubConversations]);

  const handleConfirmDeleteGitHubConversationComment = useCallback(async (comment: GitHubPrThreadComment) => {
    const author = comment.authorLogin ? ` from ${comment.authorLogin}` : '';
    const isReply = Boolean(comment.replyToNodeId);
    return popup.confirm({
      title: isReply ? 'Delete GitHub reply?' : 'Delete GitHub comment?',
      message: `This will delete the ${isReply ? 'reply' : 'comment'}${author} from the GitHub pull request conversation.`,
      confirmLabel: isReply ? 'Delete reply' : 'Delete comment',
      cancelLabel: 'Cancel',
      danger: true,
    });
  }, [popup]);

  const githubConversationControls = useMemo(() => (
    prReviewId
      ? {
          onReplyThread: handleReplyToGitHubConversation,
          onSetThreadResolved: handleSetGitHubConversationResolved,
          onUpdateComment: handleUpdateGitHubConversationComment,
          onDeleteComment: handleDeleteGitHubConversationComment,
          onConfirmDeleteComment: handleConfirmDeleteGitHubConversationComment,
          onAskAgent: onAskAtlasGitHubThread,
          busyThreadId: githubConversationActionThreadId,
          busyCommentId: githubConversationActionCommentId,
        }
      : undefined
  ), [
    prReviewId,
    handleReplyToGitHubConversation,
    handleSetGitHubConversationResolved,
    handleUpdateGitHubConversationComment,
    handleDeleteGitHubConversationComment,
    handleConfirmDeleteGitHubConversationComment,
    onAskAtlasGitHubThread,
    githubConversationActionThreadId,
    githubConversationActionCommentId,
  ]);

  const loadBranchFileContents = useCallback(async (paths: string[]) => {
    const reviewId = branchReviewId || workspaceReviewId || prReviewId;
    if (!reviewId || paths.length === 0) return;

    const normalizedPaths = Array.from(
      new Set(paths.map((path) => String(path || '').trim()).filter(Boolean))
    );
    if (normalizedPaths.length === 0) return;

    const fileByPath = new Map(brFiles.map((file) => [file.path, file]));
    const requestedPathsList = normalizedPaths.filter((path) => {
      const file = fileByPath.get(path);
      return !!file && !file.contentLoaded && !file.contentLoading;
    });
    if (requestedPathsList.length === 0) return;

    const requestedPaths = new Set(requestedPathsList);
    setBrFiles((prev) => prev.map((file) => (
      requestedPaths.has(file.path)
        ? { ...file, contentLoading: true, contentError: null }
        : file
    )));

    const requestToken = requestIdRef.current;

    try {
      const response = prReviewId
        ? await prReviewApi.getFileContents(projectId, prReviewId, [...requestedPaths])
        : workspaceReviewId
          ? await workspaceReviewApi.getFileContents(projectId, workspaceReviewId, [...requestedPaths])
          : await branchReviewApi.getFileContents(projectId, branchReviewId!, [...requestedPaths]);
      if (requestToken !== requestIdRef.current) return;

      const responseByPath = new Map<string, BranchReviewFileContent>();
      for (const file of (response.files || []) as any[]) {
        if (file?.path) responseByPath.set(file.path, file);
      }
      const missingPaths = new Set(response.missingPaths || []);

      setBrFiles((prev) => prev.map((file) => {
        if (!requestedPaths.has(file.path)) return file;
        const loaded = responseByPath.get(file.path);
        if (loaded) {
          return {
            ...file,
            status: loaded.status || file.status,
            oldPath: loaded.oldPath ?? file.oldPath,
            before: loaded.before,
            after: loaded.after,
            patch: typeof loaded.patch === 'string' ? loaded.patch : null,
            contentLoaded: true,
            contentLoading: false,
            contentError: null,
          };
        }
        if (missingPaths.has(file.path)) {
          return {
            ...file,
            contentLoading: false,
            contentError: 'File is no longer part of this branch diff.',
          };
        }
        return {
          ...file,
          contentLoading: false,
          contentError: 'Failed to load file content.',
        };
      }));
    } catch {
      if (requestToken !== requestIdRef.current) return;
      setBrFiles((prev) => prev.map((file) => {
        if (!requestedPaths.has(file.path)) return file;
        return {
          ...file,
          contentLoading: false,
          contentError: 'Failed to load file content.',
        };
      }));
    }
  }, [projectId, branchReviewId, workspaceReviewId, prReviewId, brFiles]);

  useEffect(() => {
    activeFileIndexRef.current = activeFileIndex;
  }, [activeFileIndex]);

  useEffect(() => {
    const currentFile = brFiles[activeFileIndex];
    activeFilePathRef.current = currentFile?.path || null;
  }, [brFiles, activeFileIndex]);

  // Load changeset or branch review detail
  const loadData = useCallback(async (options?: { forceRefresh?: boolean; includeAllFiles?: boolean }) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const previousActivePath = activeFilePathRef.current;
    const previousActiveIndex = activeFileIndexRef.current;
    setIsLoading(true);
    setIsLoadingAllFiles(Boolean(options?.includeAllFiles));
    setLoadError(null);
    setSummaryReviewData(null);
    summaryReviewFetchedRef.current = null;
    setBrFiles([]);
    setBrReviewData(null);
    setBranchReviewSnapshot(null);
    setBrCommitMessages([]);
    setPrBodyText(null);
    setDiffManifestSummary(null);
    setPrReviewMeta(null);
    setChangeset(null);
    setFilesFeedViewportPaths([]);
    try {
      if (branchReviewId || workspaceReviewId) {
        const response = branchReviewId
          ? await branchReviewApi.get(
              projectId,
              branchReviewId,
              {
                ...(options?.forceRefresh ? { forceRefresh: true } : {}),
                ...(options?.includeAllFiles ? { includeAllFiles: true } : {}),
                ...(visibleFileLimit && !options?.includeAllFiles ? { visibleFileLimit } : {}),
              }
            )
          : await workspaceReviewApi.get(
              projectId,
              workspaceReviewId!,
              {
                ...(options?.forceRefresh ? { includeContent: false } : {}),
                ...(options?.includeAllFiles ? { includeAllFiles: true } : {}),
                ...(visibleFileLimit && !options?.includeAllFiles ? { visibleFileLimit } : {}),
              }
            );
        if (requestId !== requestIdRef.current) return;
        const br = branchReviewId
          ? (response as Awaited<ReturnType<typeof branchReviewApi.get>>).branchReview
          : (response as Awaited<ReturnType<typeof workspaceReviewApi.get>>).workspaceReview;
        setDiffManifestSummary(br.diffManifestSummary || null);
        const snapshot = {
          id: br.id,
          branchName: br.branchName,
          baseBranch: br.baseBranch || 'working tree',
          headSha: typeof br.headSha === 'string' && br.headSha.trim() ? br.headSha : null,
          commitCount: Number(br.commitCount || 0),
          fileCount: Number(br.fileCount || 0),
          updatedAt: br.updatedAt || null,
        };
        setBranchReviewSnapshot(snapshot);
        onBranchReviewSnapshotChange?.(snapshot);
        const mappedFiles: BranchReviewDiffFile[] = (br.files || []).map((f: BranchReviewFileSummary) => ({
          path: f.path,
          additions: Number(f.additions || 0),
          deletions: Number(f.deletions || 0),
          status: f.status || 'M',
          oldPath: f.oldPath || null,
          before: null,
          after: null,
          patch: null,
          language: f.path.split('.').pop() || '',
          contentLoaded: false,
          contentLoading: false,
          contentError: null,
        }));
        const orderedMappedFiles = [...mappedFiles].sort((a, b) => {
          const aRenamed = isRenamedBranchFile(a);
          const bRenamed = isRenamedBranchFile(b);
          if (aRenamed === bRenamed) return 0;
          return aRenamed ? 1 : -1;
        });
        let nextActiveIndex = 0;
        if (orderedMappedFiles.length > 0) {
          if (previousActivePath) {
            const exactPathIndex = orderedMappedFiles.findIndex((file) => file.path === previousActivePath);
            if (exactPathIndex >= 0) {
              nextActiveIndex = exactPathIndex;
            } else {
              const renamedPathIndex = orderedMappedFiles.findIndex((file) => file.oldPath === previousActivePath);
              if (renamedPathIndex >= 0) {
                nextActiveIndex = renamedPathIndex;
              } else {
                nextActiveIndex = Math.min(Math.max(previousActiveIndex, 0), orderedMappedFiles.length - 1);
              }
            }
          } else {
            nextActiveIndex = Math.min(Math.max(previousActiveIndex, 0), orderedMappedFiles.length - 1);
          }
        }
        setBrFiles(orderedMappedFiles);
        setActiveFileIndex(nextActiveIndex);
        // Parse AI review data for BRs (Phase 3 — stored as reviewJson)
        const reviewJsonRaw = (br as any).reviewJson;
        let parsedReviewData: any = null;
        if (reviewJsonRaw) {
          if (typeof reviewJsonRaw === 'string') {
            try {
              parsedReviewData = JSON.parse(reviewJsonRaw);
            } catch (error) {
              console.warn('Invalid branch review JSON payload:', error);
            }
          } else {
            parsedReviewData = reviewJsonRaw;
          }
        }
        setBrReviewData(parsedReviewData);
        // Capture commit messages for fallback summary
        const commits = Array.isArray((br as any).commits) ? (br as any).commits : [];
        setBrCommitMessages(commits.map((c: any) => String(c.message || '')).filter(Boolean));
      } else if (prReviewId) {
        const response = await prReviewApi.get(
          projectId,
          prReviewId,
          options?.includeAllFiles
            ? { includeAllFiles: true }
            : (visibleFileLimit ? { visibleFileLimit } : undefined)
        );
        if (requestId !== requestIdRef.current) return;
        onBranchReviewSnapshotChange?.(null);
        setBranchReviewSnapshot(null);
        setPrBodyText(response.prReview?.body || null);
        setDiffManifestSummary(response.prReview?.diffManifestSummary || null);
        setPrReviewMeta(response.prReview ? {
          id: response.prReview.id,
          githubPrNumber: response.prReview.githubPrNumber,
          title: response.prReview.title,
          displayId: response.prReview.displayId,
          htmlUrl: response.prReview.htmlUrl,
          authorLogin: response.prReview.authorLogin,
        } : null);
        const prFiles = response.files || [];
        const mappedFiles: BranchReviewDiffFile[] = prFiles.map((f) => ({
          path: f.path,
          additions: Number(f.additions || 0),
          deletions: Number(f.deletions || 0),
          status: f.status || 'M',
          oldPath: f.oldPath || null,
          before: null,
          after: null,
          patch: null,
          language: f.path.split('.').pop() || '',
          contentLoaded: false,
          contentLoading: false,
          contentError: null,
        }));
        setBrFiles(mappedFiles);
        setActiveFileIndex(0);
        // Parse review data if available
        const reviewJsonRaw = response.prReview?.reviewJson;
        let parsedReviewData: any = null;
        if (reviewJsonRaw) {
          if (typeof reviewJsonRaw === 'string') {
            try { parsedReviewData = JSON.parse(reviewJsonRaw); } catch { /* ignore */ }
          } else {
            parsedReviewData = reviewJsonRaw;
          }
        }
        setBrReviewData(parsedReviewData);
      } else if (changesetId) {
        const response = await changesetApi.get(projectId, changesetId);
        if (requestId !== requestIdRef.current) return;
        onBranchReviewSnapshotChange?.(null);
        setBranchReviewSnapshot(null);
        setDiffManifestSummary(null);
        setActiveFileIndex(0);
        setChangeset(response.changeset);
      }
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      console.error('Failed to load diff data:', error);
      setLoadError('Failed to load diff details');
    } finally {
      if (requestId !== requestIdRef.current) return;
      setIsLoading(false);
      setIsLoadingAllFiles(false);
    }
  }, [projectId, changesetId, branchReviewId, workspaceReviewId, prReviewId, onBranchReviewSnapshotChange, visibleFileLimit]);

  useEffect(() => {
    void loadData({ forceRefresh: !!(branchReviewId || workspaceReviewId) && branchReviewRefreshToken > 0 });
  }, [loadData, branchReviewRefreshToken, branchReviewId, workspaceReviewId]);

  useEffect(() => {
    if (!branchReviewId && !workspaceReviewId) {
      onBranchReviewSnapshotChange?.(null);
    }
  }, [branchReviewId, workspaceReviewId, onBranchReviewSnapshotChange]);

  // Lazy review data for summary view — derive from already-loaded data, or
  // fetch independently if not yet available
  useEffect(() => {
    // Already loaded review data — derive summary from it
    const existing = (branchReviewId || workspaceReviewId || prReviewId) ? brReviewData : changeset?.reviewData;
    if (existing) {
      const key = branchReviewId || workspaceReviewId || prReviewId || changesetId || '';
      if (summaryReviewFetchedRef.current === key && summaryReviewData) return;
      summaryReviewFetchedRef.current = key;
      setSummaryReviewData({
        summary: existing.summary || '',
        riskLevel: existing.riskLevel || 'low',
        changeGroups: Array.isArray(existing.changeGroups) ? existing.changeGroups : [],
        stats: existing.stats || {},
      });
      setIsLoadingSummaryReview(false);
      return;
    }

    // No review data yet — attempt to fetch it
    const key = branchReviewId || workspaceReviewId || prReviewId || changesetId || '';
    if (!key || summaryReviewFetchedRef.current === key) return;
    summaryReviewFetchedRef.current = key;
    setIsLoadingSummaryReview(true);

    (async () => {
      try {
        if (branchReviewId) {
          const response = await branchReviewApi.get(projectId, branchReviewId);
          const reviewJson = (response.branchReview as any).reviewJson;
          let parsed: any = null;
          if (reviewJson) {
            parsed = typeof reviewJson === 'string' ? JSON.parse(reviewJson) : reviewJson;
          }
          if (parsed) {
            setSummaryReviewData({
              summary: parsed.summary || '',
              riskLevel: parsed.riskLevel || 'low',
              changeGroups: Array.isArray(parsed.changeGroups) ? parsed.changeGroups : [],
              stats: parsed.stats || {},
            });
          }
        } else if (workspaceReviewId) {
          const response = await workspaceReviewApi.get(projectId, workspaceReviewId);
          const reviewJson = (response.workspaceReview as any).reviewJson;
          let parsed: any = null;
          if (reviewJson) {
            parsed = typeof reviewJson === 'string' ? JSON.parse(reviewJson) : reviewJson;
          }
          if (parsed) {
            setSummaryReviewData({
              summary: parsed.summary || '',
              riskLevel: parsed.riskLevel || 'low',
              changeGroups: Array.isArray(parsed.changeGroups) ? parsed.changeGroups : [],
              stats: parsed.stats || {},
            });
          }
        } else if (prReviewId) {
          const response = await prReviewApi.get(projectId, prReviewId);
          const reviewJson = response.prReview?.reviewJson;
          let parsed: any = null;
          if (reviewJson) {
            parsed = typeof reviewJson === 'string' ? JSON.parse(reviewJson) : reviewJson;
          }
          if (parsed) {
            setSummaryReviewData({
              summary: parsed.summary || '',
              riskLevel: parsed.riskLevel || 'low',
              changeGroups: Array.isArray(parsed.changeGroups) ? parsed.changeGroups : [],
              stats: parsed.stats || {},
            });
          }
        } else if (changesetId) {
          const response = await changesetApi.get(projectId, changesetId);
          const rd = response.changeset.reviewData;
          if (rd) {
            setSummaryReviewData({
              summary: rd.summary || '',
              riskLevel: rd.riskLevel || 'low',
              changeGroups: Array.isArray(rd.changeGroups) ? rd.changeGroups : [],
              stats: rd.stats || ({} as any),
            });
          }
        }
      } catch (err) {
        console.warn('Failed to load review data for summary view:', err);
      } finally {
        setIsLoadingSummaryReview(false);
      }
    })();
  }, [branchReviewId, workspaceReviewId, prReviewId, changesetId, projectId, brReviewData, changeset?.reviewData, summaryReviewData]);

  useEffect(() => {
    if (!isBrMode || isFilesFeedMode || brFiles.length === 0) return;

    const active = brFiles[activeFileIndex];
    if (active && !active.contentLoaded && !active.contentLoading) {
      void loadBranchFileContents([active.path]);
    }

    const prefetchPaths = brFiles
      .slice(activeFileIndex + 1, activeFileIndex + 1 + BR_PREFETCH_BATCH_SIZE)
      .filter((file) => !file.contentLoaded && !file.contentLoading)
      .map((file) => file.path);
    if (prefetchPaths.length > 0) {
      void loadBranchFileContents(prefetchPaths);
    }
  }, [isBrMode, isFilesFeedMode, brFiles, activeFileIndex, loadBranchFileContents]);

  const handleSummaryActiveFileChange = useCallback((path: string) => {
    const nextIndex = brFiles.findIndex((file) => file.path === path || file.oldPath === path);
    if (nextIndex >= 0 && nextIndex !== activeFileIndexRef.current) {
      setActiveFileIndex(nextIndex);
    }
    onActiveFileChange?.(path);
  }, [brFiles, onActiveFileChange]);

  const handleFilesFeedViewportChange = useCallback((paths: string[]) => {
    setFilesFeedViewportPaths((prev) => {
      if (prev.length === paths.length && prev.every((path, index) => path === paths[index])) {
        return prev;
      }
      return paths;
    });
  }, []);

  useEffect(() => {
    if (!isBrMode || !isFilesFeedMode || brFiles.length === 0) return;

    const fileByPath = new Map(brFiles.map((file) => [file.path, file]));
    const indexByPath = new Map(brFiles.map((file, index) => [file.path, index]));
    const candidatePaths: string[] = [];
    const addCandidate = (path: string | null | undefined) => {
      if (!path || candidatePaths.includes(path)) return;
      candidatePaths.push(path);
    };

    if (filesFeedViewportPaths.length > 0) {
      for (const path of filesFeedViewportPaths) addCandidate(path);
    } else {
      addCandidate(brFiles[activeFileIndex]?.path);
    }

    const viewportIndexes = filesFeedViewportPaths
      .map((path) => indexByPath.get(path))
      .filter((index): index is number => typeof index === 'number');
    const prefetchAnchorIndex = viewportIndexes.length > 0
      ? Math.max(...viewportIndexes)
      : activeFileIndex;
    for (
      let index = prefetchAnchorIndex + 1;
      index < Math.min(brFiles.length, prefetchAnchorIndex + 1 + FILES_FEED_PREFETCH_AFTER_COUNT);
      index += 1
    ) {
      addCandidate(brFiles[index]?.path);
    }

    const pathsToLoad = candidatePaths
      .map((path) => fileByPath.get(path))
      .filter((file): file is BranchReviewDiffFile => Boolean(file))
      .filter((file) => !file.contentLoaded && !file.contentLoading)
      .map((file) => file.path)
      .slice(0, FILES_FEED_LOAD_BATCH_SIZE);

    if (pathsToLoad.length > 0) {
      void loadBranchFileContents(pathsToLoad);
    }
  }, [isBrMode, isFilesFeedMode, brFiles, filesFeedViewportPaths, activeFileIndex, loadBranchFileContents]);

  useEffect(() => {
    if (!isBrMode) return;
    const loadedCount = brFiles.filter((file) => file.contentLoaded).length;
    const maxLoadedFiles = isFilesFeedMode ? FILES_FEED_MAX_LOADED_FILES : BR_MAX_LOADED_FILES;
    if (loadedCount <= maxLoadedFiles) return;

    setBrFiles((prev) => {
      const loadedIndexes = prev
        .map((file, index) => (file.contentLoaded ? index : -1))
        .filter((index) => index >= 0);
      if (loadedIndexes.length <= maxLoadedFiles) return prev;

      const keepIndexes = new Set<number>();
      if (isFilesFeedMode) {
        const indexByPath = new Map(prev.map((file, index) => [file.path, index]));
        const viewportIndexes = filesFeedViewportPaths
          .map((path) => indexByPath.get(path))
          .filter((index): index is number => typeof index === 'number');
        for (const index of viewportIndexes) keepIndexes.add(index);
        if (viewportIndexes.length > 0) {
          const start = Math.max(0, Math.min(...viewportIndexes) - 2);
          const end = Math.min(prev.length - 1, Math.max(...viewportIndexes) + FILES_FEED_PREFETCH_AFTER_COUNT);
          for (let index = start; index <= end; index += 1) {
            if (prev[index]?.contentLoaded) keepIndexes.add(index);
          }
        }
      }

      for (const index of [...loadedIndexes].sort((a, b) => Math.abs(a - activeFileIndex) - Math.abs(b - activeFileIndex))) {
        if (keepIndexes.size >= maxLoadedFiles) break;
        keepIndexes.add(index);
      }

      let changed = false;
      const next = prev.map((file, index) => {
        if (!file.contentLoaded || keepIndexes.has(index)) return file;
        changed = true;
        return {
          ...file,
          before: null,
          after: null,
          patch: null,
          contentLoaded: false,
          contentLoading: false,
          contentError: null,
        };
      });

      return changed ? next : prev;
    });
  }, [isBrMode, isFilesFeedMode, activeFileIndex, brFiles, filesFeedViewportPaths]);

  // Expose file switching callback to parent
  const switchToFile = useCallback((target: DiffNavigationTarget) => {
    const normalizedTarget = normalizeNavigationTarget(target);
    if (!normalizedTarget) return;
    const { filePath, line, side, suppressNearestDiffToast } = normalizedTarget;
    const currentFiles = isBrMode ? brFiles : (changeset?.files || []);
    const filesStillLoading = isLoading || currentFiles.length === 0;
    const activeFilterSet = new Set(
      (fileFilterPaths || [])
        .map((path) => String(path || '').trim())
        .filter(Boolean)
    );
    const hasActiveFilter = activeFilterSet.size > 0;
    const idx = currentFiles.findIndex((file) => {
      if (file.path === filePath) return true;
      if (!isBrMode) return false;
      const brFile = file as BranchReviewDiffFile;
      return brFile.oldPath === filePath;
    });
    if (idx >= 0) {
      if (summaryDiffViewRef.current) {
        const handled = summaryDiffViewRef.current.scrollToFile(filePath, line ?? undefined, {
          side,
          suppressNearestDiffToast,
        });
        if (handled) return;
      }
      if (hasActiveFilter) {
        const selectedFile = currentFiles[idx];
        const inFilter = activeFilterSet.has(selectedFile.path)
          || (isBrMode
            && Boolean((selectedFile as BranchReviewDiffFile).oldPath
              && activeFilterSet.has((selectedFile as BranchReviewDiffFile).oldPath as string)));
        if (!inFilter) {
          if (onClearFileFilter) {
            pendingNavigationAfterFilterClearRef.current = line
              ? { filePath, line, side, suppressNearestDiffToast }
              : filePath;
            onClearFileFilter();
            toast('Cleared file filter to navigate to finding.', { icon: 'ℹ️' });
            return;
          }
          toast('File is outside current group filter. Clear filter to navigate.', { icon: 'ℹ️' });
          return;
        }
      }
      setActiveFileIndex(idx);
      requestAnimationFrame(() => {
        summaryDiffViewRef.current?.scrollToFile(filePath, line ?? undefined, {
          side,
          suppressNearestDiffToast,
        });
      });
    } else {
      if (filesStillLoading) {
        pendingNavigationUntilFilesReadyRef.current = line ? { filePath, line, side } : filePath;
        return;
      }
      toast('File not found in current diff', { icon: 'ℹ️' });
    }
  }, [isBrMode, brFiles, changeset, fileFilterPaths, onClearFileFilter, isLoading]);

  useEffect(() => {
    const pendingTarget = pendingNavigationUntilFilesReadyRef.current;
    if (!pendingTarget) return;

    const currentFiles = isBrMode ? brFiles : (changeset?.files || []);
    if (isLoading) return;
    if (loadError) {
      pendingNavigationUntilFilesReadyRef.current = null;
      return;
    }
    if (currentFiles.length === 0) return;

    pendingNavigationUntilFilesReadyRef.current = null;
    requestAnimationFrame(() => {
      switchToFile(pendingTarget);
    });
  }, [isBrMode, brFiles, changeset, isLoading, loadError, switchToFile]);

  useEffect(() => {
    if (onScrollToFileRef) {
      onScrollToFileRef.current = switchToFile;
    }
    return () => {
      if (onScrollToFileRef) {
        onScrollToFileRef.current = null;
      }
    };
  }, [switchToFile, onScrollToFileRef]);

  // ── Compute diff for active file ──────────────────────────────────

  const allFiles = isBrMode ? brFiles : (changeset?.files || []);
  const normalizedFileFilterSet = useMemo(() => {
    const cleaned = (fileFilterPaths || [])
      .map((path) => String(path || '').trim())
      .filter(Boolean);
    return new Set(cleaned);
  }, [fileFilterPaths]);
  const hasActiveFileFilter = normalizedFileFilterSet.size > 0;
  useEffect(() => {
    if (hasActiveFileFilter) return;
    const pendingTarget = pendingNavigationAfterFilterClearRef.current;
    if (!pendingTarget) return;
    pendingNavigationAfterFilterClearRef.current = null;
    window.requestAnimationFrame(() => {
      switchToFile(pendingTarget);
    });
  }, [hasActiveFileFilter, switchToFile]);
  const fileEntries = useMemo(() => {
    if (!hasActiveFileFilter) {
      return allFiles.map((file, index) => ({ file, allIndex: index }));
    }
    return allFiles
      .map((file, index) => ({ file, allIndex: index }))
      .filter(({ file }) => {
        if (normalizedFileFilterSet.has(file.path)) return true;
        if (!isBrMode) return false;
        const brFile = file as BranchReviewDiffFile;
        return Boolean(brFile.oldPath && normalizedFileFilterSet.has(brFile.oldPath));
      });
  }, [allFiles, hasActiveFileFilter, normalizedFileFilterSet, isBrMode]);
  const files = useMemo(() => fileEntries.map((entry) => entry.file), [fileEntries]);
  const visibleAllFileIndexes = useMemo(
    () => fileEntries.map((entry) => entry.allIndex),
    [fileEntries]
  );
  const activeVisibleFileIndex = useMemo(
    () => visibleAllFileIndexes.indexOf(activeFileIndex),
    [visibleAllFileIndexes, activeFileIndex]
  );
  const totalVisibleFileCount = diffManifestSummary?.visibleCount ?? allFiles.length;
  const totalManifestFileCount = diffManifestSummary?.totalCount ?? totalVisibleFileCount;
  const hiddenManifestFileCount = diffManifestSummary?.hiddenCount ?? Math.max(0, totalManifestFileCount - totalVisibleFileCount);
  const canLoadAllManifestFiles = hiddenManifestFileCount > 0 && Boolean(branchReviewId || prReviewId);

  const handleLoadAllFiles = useCallback(() => {
    if (!canLoadAllManifestFiles || isLoading || isLoadingAllFiles) return;
    void loadData({ forceRefresh: true, includeAllFiles: true });
  }, [canLoadAllManifestFiles, isLoading, isLoadingAllFiles, loadData]);

  useEffect(() => {
    if (files.length === 0) return;
    if (activeVisibleFileIndex >= 0) return;
    setActiveFileIndex(visibleAllFileIndexes[0] ?? 0);
  }, [files.length, activeVisibleFileIndex, visibleAllFileIndexes]);

  const failedBrFilePaths = isBrMode
    ? brFiles.filter((file) => !!file.contentError).map((file) => file.path)
    : [];
  const failedBrFileCount = failedBrFilePaths.length;

  const retryFailedBranchFiles = useCallback(() => {
    if (!isBrMode || failedBrFilePaths.length === 0) return;
    void loadBranchFileContents(failedBrFilePaths);
  }, [isBrMode, failedBrFilePaths, loadBranchFileContents]);

  // ── Per-file stats (cached) ────────────────────────────────────────

  const fileStatsByPath = useMemo(() => {
    const map = new Map<string, { additions: number; deletions: number }>();
    if (isBrMode) {
      for (const file of brFiles) {
        map.set(file.path, {
          additions: file.additions,
          deletions: file.deletions,
        });
      }
      return map;
    }
    for (const file of changeset?.files || []) {
      map.set(file.path, fileStats(file));
    }
    return map;
  }, [isBrMode, brFiles, changeset?.files]);

  // ── Summary view files (all files with content for the collapsible list) ──

  const summaryFiles = useMemo<SummaryFileEntry[]>(() => {
    return allFiles.map((file) => {
      const brFile = isBrMode ? (file as BranchReviewDiffFile) : null;
      return {
        path: file.path,
        before: file.before,
        after: file.after,
        status: brFile?.status || (file.before === null ? 'A' : file.after === null ? 'D' : 'M'),
        additions: brFile?.additions ?? fileStatsByPath.get(file.path)?.additions,
        deletions: brFile?.deletions ?? fileStatsByPath.get(file.path)?.deletions,
        patch: brFile?.patch ?? null,
        contentLoaded: brFile ? brFile.contentLoaded : true,
        contentLoading: brFile ? brFile.contentLoading : false,
      };
    });
  }, [allFiles, isBrMode, fileStatsByPath]);

  // Fallback summary text when no AI review is available
  const fallbackSummary = useMemo(() => {
    if (isBrMode) {
      // PR review: use PR body/description
      if (prReviewId && prBodyText) return prBodyText;
      // Branch review: use commit messages
      if (brCommitMessages.length > 0) return brCommitMessages.join('\n');
      return null;
    }
    // Changeset: use title + optional summary
    if (changeset) {
      const parts = [changeset.title];
      if (changeset.summary) parts.push(changeset.summary);
      return parts.join(' — ');
    }
    return null;
  }, [isBrMode, prReviewId, prBodyText, brCommitMessages, changeset]);

  // ── Confidence map ─────────────────────────────────────────────────

  const reviewData = isBrMode ? brReviewData : changeset?.reviewData;
  const reviewDiffRecommendations = useMemo(
    () => getReviewDiffRecommendations(reviewData),
    [reviewData]
  );
  const reviewDataForDiffTree = useMemo(() => (
    reviewData
      ? {
          ...reviewData,
          recommendations: reviewDiffRecommendations,
        }
      : null
  ), [reviewData, reviewDiffRecommendations]);
  const recommendationFingerprintToken = useMemo(
    () => reviewDiffRecommendations
      .filter((rec: ReviewRecommendation) => rec.type !== 'praise')
      .map((rec: ReviewRecommendation) => getRecommendationFingerprint(rec))
      .join('||'),
    [reviewDiffRecommendations]
  );
  const summaryTreeSource = useMemo(() => {
    const key = allFiles
      .map((file) => {
        const brFile = isBrMode ? (file as BranchReviewDiffFile) : null;
        const status = brFile?.status || (file.before === null ? 'A' : file.after === null ? 'D' : 'M');
        const additions = brFile?.additions ?? fileStatsByPath.get(file.path)?.additions ?? 0;
        const deletions = brFile?.deletions ?? fileStatsByPath.get(file.path)?.deletions ?? 0;
        const oldPath = brFile?.oldPath || '';
        return `${file.path}\u0001${oldPath}\u0001${status}\u0001${additions}\u0001${deletions}`;
      })
      .join('\u0002');

    if (summaryTreeSourceCacheRef.current.key === key) {
      return summaryTreeSourceCacheRef.current;
    }

    const next = {
      key,
      files: allFiles.map((file) => {
        const brFile = isBrMode ? (file as BranchReviewDiffFile) : null;
        return {
          path: file.path,
          status: brFile?.status || (file.before === null ? 'A' : file.after === null ? 'D' : 'M'),
          oldPath: brFile?.oldPath || null,
          additions: brFile?.additions ?? fileStatsByPath.get(file.path)?.additions,
          deletions: brFile?.deletions ?? fileStatsByPath.get(file.path)?.deletions,
        };
      }),
    };
    summaryTreeSourceCacheRef.current = next;
    return next;
  }, [allFiles, isBrMode, fileStatsByPath]);
  const summaryFileTree = useMemo(() => buildReviewFileTree({
    files: summaryTreeSource.files,
    review: reviewDataForDiffTree,
  }), [summaryTreeSource, reviewDataForDiffTree]);
  const shortcutFilePaths = useMemo(() => {
    const visibleTree = getReviewFileTreeVisibleState({
      tree: summaryFileTree,
      activePaths: activeFileFilter?.paths || null,
    });
    return flattenReviewFileTreeEntriesByFolder([
      ...visibleTree.standaloneEntries,
      ...visibleTree.buckets.flatMap((bucket) => bucket.entries),
    ]).map((entry) => entry.path);
  }, [activeFileFilter?.paths, summaryFileTree]);
  const navigateFileShortcut = useCallback((delta: number) => {
    if (shortcutFilePaths.length === 0) return;
    const currentPath = allFiles[activeFileIndex]?.path || null;
    const currentShortcutIndex = currentPath ? shortcutFilePaths.indexOf(currentPath) : -1;
    const fromIndex = currentShortcutIndex >= 0 ? currentShortcutIndex : 0;
    const nextShortcutIndex = Math.max(0, Math.min(shortcutFilePaths.length - 1, fromIndex + delta));
    const nextPath = shortcutFilePaths[nextShortcutIndex];
    if (!nextPath) return;
    const nextAllIndex = allFiles.findIndex((file) => file.path === nextPath);
    if (nextAllIndex < 0) return;
    setActiveFileIndex(nextAllIndex);
    requestAnimationFrame(() => {
      summaryDiffViewRef.current?.scrollToFile(nextPath);
    });
  }, [activeFileIndex, allFiles, shortcutFilePaths]);

  const readRecommendationCommentsFromStorage = useCallback((): RecommendationCommentMap => {
    if (!recommendationCommentStorageKey) return {};
    try {
      const raw = localStorage.getItem(recommendationCommentStorageKey);
      return raw ? normalizeRecommendationCommentMap(JSON.parse(raw)) : {};
    } catch {
      return {};
    }
  }, [recommendationCommentStorageKey]);

  const readManualLineCommentsFromStorage = useCallback((): ManualLineCommentMap => {
    if (!manualLineCommentStorageKey) return {};
    try {
      const raw = localStorage.getItem(manualLineCommentStorageKey);
      return raw ? normalizeManualLineCommentMap(JSON.parse(raw)) : {};
    } catch {
      return {};
    }
  }, [manualLineCommentStorageKey]);

  useEffect(() => {
    if (!recommendationCommentStorageKey) {
      setHydratedRecommendationCommentStorageKey(null);
      setRecommendationComments({});
      return;
    }
    setRecommendationComments(readRecommendationCommentsFromStorage());
    setHydratedRecommendationCommentStorageKey(recommendationCommentStorageKey);
  }, [recommendationCommentStorageKey, readRecommendationCommentsFromStorage]);

  useEffect(() => {
    if (!recommendationCommentStorageKey || hydratedRecommendationCommentStorageKey !== recommendationCommentStorageKey) return;
    try {
      localStorage.setItem(recommendationCommentStorageKey, JSON.stringify(recommendationComments));
      window.dispatchEvent(new CustomEvent<ReviewCommentDraftsUpdatedDetail>(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, {
        detail: {
          kind: 'recommendation',
          storageKey: recommendationCommentStorageKey,
          sourceId: commentDraftSyncSourceIdRef.current,
        },
      }));
    } catch {
      // Ignore storage write failures (quota/private mode)
    }
  }, [recommendationCommentStorageKey, hydratedRecommendationCommentStorageKey, recommendationComments]);

  useEffect(() => {
    if (!manualLineCommentStorageKey) {
      setHydratedManualLineCommentStorageKey(null);
      setManualLineComments({});
      return;
    }
    setManualLineComments(readManualLineCommentsFromStorage());
    setHydratedManualLineCommentStorageKey(manualLineCommentStorageKey);
  }, [manualLineCommentStorageKey, readManualLineCommentsFromStorage]);

  useEffect(() => {
    if (!manualLineCommentStorageKey || hydratedManualLineCommentStorageKey !== manualLineCommentStorageKey) return;
    try {
      localStorage.setItem(manualLineCommentStorageKey, JSON.stringify(manualLineComments));
      window.dispatchEvent(new CustomEvent<ReviewCommentDraftsUpdatedDetail>(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, {
        detail: {
          kind: 'manual_line',
          storageKey: manualLineCommentStorageKey,
          sourceId: commentDraftSyncSourceIdRef.current,
        },
      }));
    } catch {
      // Ignore storage write failures (quota/private mode)
    }
  }, [manualLineCommentStorageKey, hydratedManualLineCommentStorageKey, manualLineComments]);

  useEffect(() => {
    if (!recommendationCommentStorageKey) return;
    const syncRecommendationComments = (event: Event) => {
      const detail = (event as CustomEvent<ReviewCommentDraftsUpdatedDetail>).detail;
      if (!detail || detail.kind !== 'recommendation' || detail.storageKey !== recommendationCommentStorageKey) return;
      if (detail.sourceId === commentDraftSyncSourceIdRef.current) return;
      const next = readRecommendationCommentsFromStorage();
      setRecommendationComments((prev) => (
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      ));
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== recommendationCommentStorageKey) return;
      const next = readRecommendationCommentsFromStorage();
      setRecommendationComments((prev) => (
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      ));
    };
    window.addEventListener(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, syncRecommendationComments as EventListener);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, syncRecommendationComments as EventListener);
      window.removeEventListener('storage', handleStorage);
    };
  }, [recommendationCommentStorageKey, readRecommendationCommentsFromStorage]);

  useEffect(() => {
    if (!manualLineCommentStorageKey) return;
    const syncManualLineComments = (event: Event) => {
      const detail = (event as CustomEvent<ReviewCommentDraftsUpdatedDetail>).detail;
      if (!detail || detail.kind !== 'manual_line' || detail.storageKey !== manualLineCommentStorageKey) return;
      if (detail.sourceId === commentDraftSyncSourceIdRef.current) return;
      const next = readManualLineCommentsFromStorage();
      setManualLineComments((prev) => (
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      ));
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== manualLineCommentStorageKey) return;
      const next = readManualLineCommentsFromStorage();
      setManualLineComments((prev) => (
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      ));
    };
    window.addEventListener(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, syncManualLineComments as EventListener);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(REVIEW_COMMENT_DRAFTS_UPDATED_EVENT, syncManualLineComments as EventListener);
      window.removeEventListener('storage', handleStorage);
    };
  }, [manualLineCommentStorageKey, readManualLineCommentsFromStorage]);

  useEffect(() => {
    if (!manualLineCommentStorageKey) return;
    const handleCleared = (event: Event) => {
      const detail = (event as CustomEvent<{ storageKey?: string; ids?: string[] }>).detail;
      if (!detail || detail.storageKey !== manualLineCommentStorageKey || !Array.isArray(detail.ids)) return;
      const idsToClear = new Set(detail.ids.map((id) => String(id || '').trim()).filter(Boolean));
      if (idsToClear.size === 0) return;
      setManualLineComments((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const id of idsToClear) {
          if (next[id]) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    window.addEventListener('atlas-review-manual-line-comments-cleared', handleCleared as EventListener);
    return () => {
      window.removeEventListener('atlas-review-manual-line-comments-cleared', handleCleared as EventListener);
    };
  }, [manualLineCommentStorageKey]);

  const loadRecommendationNotes = useCallback(() => {
    if (!recommendationNoteStorageKey) return {};
    try {
      const raw = localStorage.getItem(recommendationNoteStorageKey);
      if (!raw) return {};
      return normalizeRecommendationNoteMap(JSON.parse(raw));
    } catch {
      return {};
    }
  }, [recommendationNoteStorageKey]);

  useEffect(() => {
    const loaded = loadRecommendationNotes();
    setRecommendationNotes(loaded);
  }, [loadRecommendationNotes]);

  useEffect(() => {
    if (!recommendationNoteStorageKey) return undefined;
    const handleNotesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ storageKey?: string }>).detail;
      if (!detail || detail.storageKey !== recommendationNoteStorageKey) return;
      setRecommendationNotes(loadRecommendationNotes());
    };
    window.addEventListener('atlas-review-finding-notes-updated', handleNotesUpdated as EventListener);
    return () => {
      window.removeEventListener('atlas-review-finding-notes-updated', handleNotesUpdated as EventListener);
    };
  }, [recommendationNoteStorageKey, loadRecommendationNotes]);

  const persistRecommendationNotes = useCallback((nextNotes: RecommendationNoteMap) => {
    if (!recommendationNoteStorageKey) return;
    try {
      if (Object.keys(nextNotes).length === 0) {
        localStorage.removeItem(recommendationNoteStorageKey);
      } else {
        localStorage.setItem(recommendationNoteStorageKey, JSON.stringify(nextNotes));
      }
      window.dispatchEvent(new CustomEvent('atlas-review-finding-notes-updated', {
        detail: { storageKey: recommendationNoteStorageKey },
      }));
    } catch {
      // Ignore storage write failures (quota/private mode)
    }
  }, [recommendationNoteStorageKey]);

  useEffect(() => {
    if (!recommendationFingerprintToken) {
      setRecommendationComments({});
      setRecommendationNotes({});
      return;
    }
    const activeFingerprintSet = new Set(recommendationFingerprintToken.split('||').filter(Boolean));
    setRecommendationComments((prev) => {
      let changed = false;
      const next: RecommendationCommentMap = {};
      for (const [fingerprint, entry] of Object.entries(prev)) {
        if (activeFingerprintSet.has(fingerprint)) {
          next[fingerprint] = entry;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setRecommendationNotes((prev) => {
      let changed = false;
      const next: RecommendationNoteMap = {};
      for (const [fingerprint, entry] of Object.entries(prev)) {
        if (activeFingerprintSet.has(fingerprint)) {
          next[fingerprint] = entry;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [recommendationFingerprintToken]);

  const handleSaveRecommendationComment = useCallback((rec: ReviewRecommendation, comment: string) => {
    if (!prReviewId || rec.type === 'praise') return;
    const trimmed = comment.trim();
    const recommendationKey = getRecommendationFingerprint(rec);
    setRecommendationComments((prev) => {
      const next = { ...prev };
      if (!trimmed) {
        delete next[recommendationKey];
        return next;
      }
      next[recommendationKey] = {
        comment: trimmed,
        updatedAt: new Date().toISOString(),
      };
      return next;
    });
  }, [prReviewId]);

  const handleClearRecommendationComment = useCallback((rec: ReviewRecommendation) => {
    const recommendationKey = getRecommendationFingerprint(rec);
    setRecommendationComments((prev) => {
      if (!prev[recommendationKey]) return prev;
      const next = { ...prev };
      delete next[recommendationKey];
      return next;
    });
  }, []);

  const getRecommendationNote = useCallback((rec: ReviewRecommendation) => {
    const recommendationKey = getRecommendationFingerprint(rec);
    return recommendationNotes[recommendationKey]?.body || '';
  }, [recommendationNotes]);

  const handleSaveRecommendationNote = useCallback((rec: ReviewRecommendation, note: string) => {
    if (!recommendationNoteStorageKey || rec.type === 'praise') return;
    const trimmed = note.trim();
    const recommendationKey = getRecommendationFingerprint(rec);
    if (!trimmed) {
      setRecommendationNotes((prev) => {
        if (!prev[recommendationKey]) return prev;
        const next = { ...prev };
        delete next[recommendationKey];
        persistRecommendationNotes(next);
        return next;
      });
      return;
    }

    const draft = buildRecommendationNoteDraft({
      rec,
      body: trimmed,
      recommendationKey,
      reviewType: prReviewId ? 'pr_review' : workspaceReviewId ? 'workspace_review' : 'branch_review',
      branchReviewId: branchReviewId || null,
      workspaceReviewId: workspaceReviewId || null,
      branchName: branchReviewSnapshot?.branchName || null,
      prReviewId: prReviewId || null,
      githubPrNumber: prReviewMeta?.githubPrNumber ?? null,
      prHtmlUrl: prReviewMeta?.htmlUrl || null,
      reviewDisplayId: prReviewMeta?.displayId || branchReviewSnapshot?.id || null,
      reviewTitle: prReviewMeta?.title || null,
    });
    if (!draft) return;

    setRecommendationNotes((prev) => {
      const next = {
        ...prev,
        [recommendationKey]: draft,
      };
      persistRecommendationNotes(next);
      return next;
    });
  }, [
    branchReviewId,
    workspaceReviewId,
    recommendationNoteStorageKey,
    persistRecommendationNotes,
    prReviewId,
    prReviewMeta?.displayId,
    prReviewMeta?.githubPrNumber,
    prReviewMeta?.htmlUrl,
    prReviewMeta?.title,
    branchReviewSnapshot?.branchName,
    branchReviewSnapshot?.id,
  ]);

  const handleClearRecommendationNote = useCallback((rec: ReviewRecommendation) => {
    const recommendationKey = getRecommendationFingerprint(rec);
    setRecommendationNotes((prev) => {
      if (!prev[recommendationKey]) return prev;
      const next = { ...prev };
      delete next[recommendationKey];
      persistRecommendationNotes(next);
      return next;
    });
  }, [persistRecommendationNotes]);

  const getManualLineComment = useCallback((path: string, line: number, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    const normalizedPath = String(path || '').trim();
    if (!normalizedPath || !Number.isFinite(Number(line)) || Number(line) <= 0) return '';
    const targetLine = Math.floor(Number(line));
    const draft = Object.values(manualLineComments).find((entry) => (
      entry.path === normalizedPath
      && entry.line === targetLine
      && (entry.side || 'RIGHT') === side
    ));
    return draft?.body || '';
  }, [manualLineComments]);

  const handleSaveManualLineComment = useCallback((path: string, line: number, body: string, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    if (!prReviewId) return;
    const normalizedPath = String(path || '').trim();
    const normalizedLine = Number.isFinite(Number(line)) && Number(line) > 0
      ? Math.floor(Number(line))
      : null;
    const trimmed = String(body || '').trim();
    if (!normalizedPath || !normalizedLine || !trimmed) return;
    setManualLineComments((prev) => {
      const existingDraft = Object.values(prev).find((entry) => (
        entry.path === normalizedPath
        && entry.line === normalizedLine
        && (entry.side || 'RIGHT') === side
      ));
      const id = existingDraft?.id || `lc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        ...prev,
        [id]: {
          id,
          path: normalizedPath,
          line: normalizedLine,
          side,
          body: trimmed,
          updatedAt: new Date().toISOString(),
        },
      };
    });
  }, [prReviewId]);

  const handleClearManualLineComment = useCallback((path: string, line: number, side: 'LEFT' | 'RIGHT' = 'RIGHT') => {
    const normalizedPath = String(path || '').trim();
    const normalizedLine = Number.isFinite(Number(line)) && Number(line) > 0
      ? Math.floor(Number(line))
      : null;
    if (!normalizedPath || !normalizedLine) return;
    setManualLineComments((prev) => {
      const existingDraft = Object.values(prev).find((entry) => (
        entry.path === normalizedPath
        && entry.line === normalizedLine
        && (entry.side || 'RIGHT') === side
      ));
      if (!existingDraft) return prev;
      const next = { ...prev };
      delete next[existingDraft.id];
      return next;
    });
  }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement | null;
      const tag = (activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (activeElement?.isContentEditable) return;
      if (e.defaultPrevented) return;

      // Cmd+D / Ctrl+D: toggle view mode
      if (e.key === 'd' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setViewMode(viewMode === 'unified' ? 'split' : 'unified');
        return;
      }

      // }: next file. Also accept Cmd/Ctrl+Shift+] (the VS Code-style alias) —
      // we match on e.code so it works on non-US keyboard layouts where
      // `e.key` may not be `}` even with shift held.
      const matchesNextFile =
        (e.key === '}' && !e.metaKey && !e.ctrlKey && !e.altKey)
        || (e.code === 'BracketRight' && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey);
      if (matchesNextFile) {
        if (shortcutFilePaths.length === 0) return;
        e.preventDefault();
        navigateFileShortcut(1);
        return;
      }
      // {: previous file. Also accept Cmd/Ctrl+Shift+[.
      const matchesPrevFile =
        (e.key === '{' && !e.metaKey && !e.ctrlKey && !e.altKey)
        || (e.code === 'BracketLeft' && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey);
      if (matchesPrevFile) {
        if (shortcutFilePaths.length === 0) return;
        e.preventDefault();
        navigateFileShortcut(-1);
        return;
      }

      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const activeInsideDiff = Boolean(diffRootRef.current?.contains(activeElement) || isDiffPaneHovered);
        if (activeInsideDiff && summaryDiffViewRef.current?.navigateHunk(e.key === 'ArrowDown' ? 'next' : 'prev')) {
          e.preventDefault();
          return;
        }
      }

      // n / p: next / previous hunk
      if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (summaryDiffViewRef.current?.navigateHunk('next')) {
          e.preventDefault();
        }
        return;
      }
      if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (summaryDiffViewRef.current?.navigateHunk('prev')) {
          e.preventDefault();
        }
        return;
      }

      // ] / [: next / previous visible diff comment
      if (e.key === ']' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (summaryDiffViewRef.current?.navigateComment('next')) {
          e.preventDefault();
        }
        return;
      }
      if (e.key === '[' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (summaryDiffViewRef.current?.navigateComment('prev')) {
          e.preventDefault();
        }
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isDiffPaneHovered, navigateFileShortcut, setViewMode, shortcutFilePaths.length, viewMode]);

  // ── Loading / error states ─────────────────────────────────────────

  if (isLoading) {
    return (
      <div style={{ ...reviewSurfaceStyle({ padded: false }), flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'var(--font-sans)' }}>
        {/* Skeleton file tabs */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          background: 'var(--review-toolbar-bg)', borderBottom: '1px solid var(--review-shell-divider)',
          padding: '0 var(--space-3)', minHeight: 32,
        }}>
          {[80, 100, 60].map((w, i) => (
            <div key={i} style={{
              width: w, height: 14, borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-overlay)', animation: 'skeleton-pulse 1.5s ease-in-out infinite',
            }} />
          ))}
        </div>
        {/* Skeleton diff lines */}
        <div style={{ flex: 1, overflow: 'hidden', padding: 'var(--space-2) 0' }}>
          {Array.from({ length: 15 }, (_, i) => (
            <div key={i} style={{ display: 'flex', minHeight: 20, padding: '0 var(--space-2)', alignItems: 'center' }}>
              <div style={{
                width: 48, height: 12, marginRight: 'var(--space-2)',
                borderRadius: 'var(--radius-sm)', background: 'var(--bg-overlay)',
                animation: 'skeleton-pulse 1.5s ease-in-out infinite',
              }} />
              <div style={{
                width: `${30 + Math.random() * 50}%`, height: 12,
                borderRadius: 'var(--radius-sm)', background: 'var(--bg-overlay)',
                animation: 'skeleton-pulse 1.5s ease-in-out infinite',
              }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const hasData = isBrMode ? true : !!changeset;

  if (loadError || (!isBrMode && !hasData)) {
    return (
      <div style={{
        ...reviewSurfaceStyle({ elevated: true }),
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-sans)',
      }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 'var(--space-3)' }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-3)' }}>
          {loadError || 'No diff data available'}
        </p>
        <button
          type="button"
          onClick={() => {
            void loadData();
          }}
          style={{
            ...getReviewActionButtonStyle({ tone: 'blue' }),
            fontSize: 'var(--text-sm)',
            padding: '0 var(--space-4)',
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  if (files.length === 0) {
    if (hasActiveFileFilter && allFiles.length > 0) {
      return (
        <div style={{
          ...reviewSurfaceStyle({ elevated: true }),
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--space-2)',
          color: 'var(--text-tertiary)',
          fontSize: 'var(--text-sm)',
          fontFamily: 'var(--font-sans)',
          textAlign: 'center',
          padding: 'var(--space-4)',
        }}>
          <span>No files match the current change-group filter.</span>
          {onClearFileFilter && (
            <button
              type="button"
              onClick={onClearFileFilter}
              style={{
                ...getReviewActionButtonStyle({ tone: 'blue' }),
                fontSize: 'var(--text-xs)',
                minHeight: 24,
                padding: '0 var(--space-2)',
              }}
            >
              Clear filter
            </button>
          )}
        </div>
      );
    }
    if (isBrMode) {
      return (
        <div style={{
          ...reviewSurfaceStyle({ elevated: true }),
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-tertiary)',
          fontSize: 'var(--text-sm)',
          fontFamily: 'var(--font-sans)',
          textAlign: 'center',
          padding: 'var(--space-4)',
        }}>
          {getEmptyReviewDiffMessage({
            isPrMode: !!prReviewId,
            branchReviewSnapshot,
          })}
        </div>
      );
    }
    return (
      <div style={{
        ...reviewSurfaceStyle({ elevated: true }),
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-tertiary)',
        fontSize: 'var(--text-sm)',
        fontFamily: 'var(--font-sans)',
      }}>
        No change set selected
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────
  const isFindingScopedDiff = activeFileFilter?.kind === 'finding';

  return (
    <div
      ref={diffRootRef}
      onMouseEnter={() => setIsDiffPaneHovered(true)}
      onMouseLeave={() => setIsDiffPaneHovered(false)}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {isBrMode && failedBrFileCount > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-1) var(--space-3)',
          fontSize: 'var(--text-xs)',
          color: 'var(--text-tertiary)',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-muted)',
          flexShrink: 0,
        }}>
          <span>
            {failedBrFileCount} file{failedBrFileCount !== 1 ? 's' : ''} failed to load
          </span>
          <button
            type="button"
            onClick={retryFailedBranchFiles}
            style={{
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--accent-blue)',
              cursor: 'pointer',
              fontSize: 'var(--text-xs)',
              fontFamily: 'var(--font-sans)',
              textDecoration: 'underline',
            }}
          >
            Retry
          </button>
        </div>
      )}
      {hasActiveFileFilter && !isFindingScopedDiff && !isFilesFeedMode && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-1) var(--space-3)',
          fontSize: 10,
          color: 'var(--text-secondary)',
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border-muted)',
          flexShrink: 0,
        }}>
          <span>
            Filtered scope: <strong style={{ color: 'var(--text-primary)' }}>{fileFilterLabel || 'selected scope'}</strong>
            {' '}· {files.length}/{allFiles.length} files
          </span>
          {onClearFileFilter && (
            <button
              type="button"
              onClick={onClearFileFilter}
              style={{
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--accent-blue)',
                cursor: 'pointer',
                fontSize: 10,
                fontFamily: 'var(--font-sans)',
                textDecoration: 'underline',
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}
      {hiddenManifestFileCount > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 'var(--space-2)',
          padding: 'var(--space-1) var(--space-3)',
          fontSize: 10,
          color: 'var(--text-secondary)',
          background: 'var(--review-toolbar-bg)',
          borderBottom: '1px solid var(--border-muted)',
          flexShrink: 0,
        }}>
          <span>
            Showing <strong style={{ color: 'var(--text-primary)' }}>{totalVisibleFileCount}</strong> of{' '}
            <strong style={{ color: 'var(--text-primary)' }}>{totalManifestFileCount}</strong> files.
            {' '}Hidden remainder: {hiddenManifestFileCount}.
          </span>
          {canLoadAllManifestFiles && (
            <button
              type="button"
              onClick={handleLoadAllFiles}
              disabled={isLoading || isLoadingAllFiles}
              style={{
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: (isLoading || isLoadingAllFiles) ? 'var(--text-tertiary)' : 'var(--accent-blue)',
                cursor: (isLoading || isLoadingAllFiles) ? 'default' : 'pointer',
                fontSize: 10,
                fontFamily: 'var(--font-sans)',
                textDecoration: 'underline',
              }}
            >
              {isLoadingAllFiles ? 'Loading all files…' : 'Load all files'}
            </button>
          )}
        </div>
      )}

      <SummaryDiffView
        ref={summaryDiffViewRef}
        files={summaryFiles}
        fileStatsByPath={fileStatsByPath}
        fileTree={summaryFileTree}
        reviewSummary={summaryReviewData}
        isLoadingReview={isLoadingSummaryReview}
        viewMode={viewMode}
        fallbackSummary={fallbackSummary}
        onRequestContent={isBrMode ? loadBranchFileContents : undefined}
        recommendations={reviewDiffRecommendations}
        recommendationResolutions={recommendationResolutions}
        githubConversationThreads={githubConversationThreads}
        githubConversationPrAuthorLogin={prReviewMeta?.authorLogin || null}
        githubConversationControls={githubConversationControls}
        canCommentOnRecommendation={Boolean(prReviewId)}
        commentingUnavailableReason={branchCommentUnavailableReason}
        getRecommendationComment={(rec) => recommendationComments[getRecommendationFingerprint(rec)]?.comment || ''}
        onSaveRecommendationComment={handleSaveRecommendationComment}
        onClearRecommendationComment={handleClearRecommendationComment}
        canAddRecommendationNotes={Boolean(recommendationNoteStorageKey)}
        getRecommendationNote={getRecommendationNote}
        onSaveRecommendationNote={handleSaveRecommendationNote}
        onClearRecommendationNote={handleClearRecommendationNote}
        canCommentOnAnyLine={Boolean(prReviewId)}
        getManualLineComment={getManualLineComment}
        onSaveManualLineComment={handleSaveManualLineComment}
        onClearManualLineComment={handleClearManualLineComment}
        activeFileFilter={activeFileFilter}
        onSelectFileFilter={onSelectFileFilter}
        onViewModeChange={setViewMode}
        presentationMode={presentationMode}
        onActiveFileChange={isFilesFeedMode ? handleSummaryActiveFileChange : undefined}
        onFilesFeedViewportChange={isFilesFeedMode ? handleFilesFeedViewportChange : undefined}
        onAskAtlasSelection={onAskAtlasSelection}
        onAskAtlasFinding={onAskAtlasFinding}
        onAskAtlasFile={onAskAtlasFile}
      />
    </div>
  );
}

export default TrustDiffViewer;
