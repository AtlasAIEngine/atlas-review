import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from '@/lib/toast';
import { branchReviewApi, prReviewApi, workspaceReviewApi } from '@/services/api';
import type { BranchReview, PrReview, WorkspaceReview } from '@/types';
import type { DiffNavigationTarget } from './TrustDiffViewer';
import {
  buildProjectRecommendationNoteHistory,
  collectProjectRecommendationNoteStorageEntries,
  normalizeRecommendationNoteMap,
  type RecommendationNoteHistoryEntry,
} from './review/reviewPanelUtils';
import { ReviewActionButton, getReviewActionButtonStyle } from './review/ReviewChrome';
import { usePopup } from './shared/PopupProvider';

interface ProjectNotesModalProps {
  isOpen: boolean;
  projectId: string;
  projectName: string;
  onClose: () => void;
  onOpenNote: (payload: {
    reviewId: string;
    reviewType: 'branch_review' | 'workspace_review' | 'pr_review';
    target: DiffNavigationTarget | null;
  }) => void;
}

type HistoryFilter = 'all' | 'available' | 'unavailable';
const NOTE_REFRESH_MODES = {
  immediate: 'immediate',
  scheduled: 'scheduled',
} as const;
const PERSONAL_NOTES_STORAGE_PREFIX = 'atlas-project-personal-notes:';
const PERSONAL_NOTES_UPDATED_EVENT = 'atlas-project-personal-notes-updated';

type PersonalProjectNoteEntry = {
  id: string;
  body: string;
  updatedAt: string;
};

function getPersonalNotesStorageKey(projectId: string): string {
  return `${PERSONAL_NOTES_STORAGE_PREFIX}${String(projectId || '').trim()}`;
}

function normalizePersonalProjectNotes(rawValue: unknown): PersonalProjectNoteEntry[] {
  if (!Array.isArray(rawValue)) return [];
  return rawValue
    .map((entry): PersonalProjectNoteEntry | null => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Partial<PersonalProjectNoteEntry>;
      const id = typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id.trim()
        : '';
      const body = typeof candidate.body === 'string' ? candidate.body.trim() : '';
      if (!id || !body) return null;
      return {
        id,
        body,
        updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim()
          ? candidate.updatedAt.trim()
          : new Date().toISOString(),
      };
    })
    .filter((entry): entry is PersonalProjectNoteEntry => Boolean(entry))
    .sort((left, right) => Date.parse(left.updatedAt || '') - Date.parse(right.updatedAt || ''));
}

function readPersonalProjectNotes(projectId: string): PersonalProjectNoteEntry[] {
  if (typeof window === 'undefined') return [];
  const storageKey = getPersonalNotesStorageKey(projectId);
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return [];
  try {
    return normalizePersonalProjectNotes(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writePersonalProjectNotes(projectId: string, notes: PersonalProjectNoteEntry[]): void {
  if (typeof window === 'undefined') return;
  const storageKey = getPersonalNotesStorageKey(projectId);
  if (notes.length === 0) {
    window.localStorage.removeItem(storageKey);
  } else {
    window.localStorage.setItem(storageKey, JSON.stringify(notes));
  }
  window.dispatchEvent(new CustomEvent(PERSONAL_NOTES_UPDATED_EVENT));
}

function formatUpdatedAt(value: string): string {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return 'Updated recently';
  return `Updated ${new Date(parsed).toLocaleString()}`;
}

function buildEntryNavigationTarget(entry: RecommendationNoteHistoryEntry): DiffNavigationTarget | null {
  if (!entry.navigationFilePath) return null;
  if (entry.navigationLine != null && entry.navigationLine > 0) {
    return {
      filePath: entry.navigationFilePath,
      line: entry.navigationLine,
    };
  }
  return entry.navigationFilePath;
}

function NoteDeleteIconButton({
  onClick,
  title,
}: {
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        ...getReviewActionButtonStyle({ tone: 'neutral' }),
        minWidth: 34,
        width: 34,
        minHeight: 34,
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-secondary)',
        flexShrink: 0,
      }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.5 4h11" />
        <path d="M6 2.5h4" />
        <path d="M4.5 4l.7 8.2a1 1 0 0 0 1 .8h3.6a1 1 0 0 0 1-.8L11.5 4" />
        <path d="M6.5 6.5v4" />
        <path d="M9.5 6.5v4" />
      </svg>
    </button>
  );
}

export default function ProjectNotesModal({
  isOpen,
  projectId,
  projectName,
  onClose,
  onOpenNote,
}: ProjectNotesModalProps) {
  const popup = usePopup();
  const [branchReviews, setBranchReviews] = useState<BranchReview[]>([]);
  const [workspaceReviews, setWorkspaceReviews] = useState<WorkspaceReview[]>([]);
  const [prReviews, setPrReviews] = useState<PrReview[]>([]);
  const [localBranches, setLocalBranches] = useState<Array<{ name: string; current: boolean }>>([]);
  const [storageEntries, setStorageEntries] = useState(() => collectProjectRecommendationNoteStorageEntries({ projectId }));
  const [personalNotes, setPersonalNotes] = useState<PersonalProjectNoteEntry[]>(() => readPersonalProjectNotes(projectId));
  const [personalNoteDraft, setPersonalNoteDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [selectedHistoricalEntry, setSelectedHistoricalEntry] = useState<RecommendationNoteHistoryEntry | null>(null);
  const projectIdRef = useRef(projectId);
  const refreshFrameRef = useRef<number | null>(null);
  projectIdRef.current = projectId;

  const refreshStoredNotes = useCallback((
    mode: (typeof NOTE_REFRESH_MODES)[keyof typeof NOTE_REFRESH_MODES] = NOTE_REFRESH_MODES.scheduled
  ) => {
    const currentProjectId = projectIdRef.current;
    if (mode === NOTE_REFRESH_MODES.immediate) {
      if (refreshFrameRef.current != null) {
        window.cancelAnimationFrame(refreshFrameRef.current);
        refreshFrameRef.current = null;
      }
      setStorageEntries(collectProjectRecommendationNoteStorageEntries({ projectId: currentProjectId }));
      setPersonalNotes(readPersonalProjectNotes(currentProjectId));
      return;
    }
    if (refreshFrameRef.current != null) return;
    refreshFrameRef.current = window.requestAnimationFrame(() => {
      refreshFrameRef.current = null;
      setStorageEntries(collectProjectRecommendationNoteStorageEntries({ projectId: currentProjectId }));
      setPersonalNotes(readPersonalProjectNotes(currentProjectId));
    });
  }, []);

  useEffect(() => {
    return () => {
      if (refreshFrameRef.current != null) {
        window.cancelAnimationFrame(refreshFrameRef.current);
        refreshFrameRef.current = null;
      }
    };
  }, []);

  const loadReviewHistoryContext = useCallback(async () => {
    if (!isOpen) return;
    try {
      setLoading(true);
      const [branchResponse, workspaceResponse, prResponse, branchListResponse] = await Promise.all([
        branchReviewApi.list(projectId),
        workspaceReviewApi.list(projectId),
        prReviewApi.list(projectId),
        branchReviewApi.listBranches(projectId),
      ]);
      setBranchReviews(branchResponse.branchReviews || []);
      setWorkspaceReviews(workspaceResponse.workspaceReviews || []);
      setPrReviews(prResponse.prReviews || []);
      setLocalBranches(branchListResponse.branches || []);
    } catch (error) {
      console.error('Failed to load project finding notes context:', error);
      toast.error('Failed to load project notes');
    } finally {
      setLoading(false);
    }
  }, [isOpen, projectId]);

  useEffect(() => {
    if (!isOpen) return;
    refreshStoredNotes(NOTE_REFRESH_MODES.immediate);
    void loadReviewHistoryContext();
  }, [isOpen, loadReviewHistoryContext, refreshStoredNotes]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleNotesUpdated = () => refreshStoredNotes();
    const handlePersonalNotesUpdated = () => refreshStoredNotes();
    const handleStorage = () => refreshStoredNotes();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshStoredNotes();
    };
    const handleFocus = () => refreshStoredNotes();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (selectedHistoricalEntry) {
          setSelectedHistoricalEntry(null);
        } else {
          onClose();
        }
      }
    };

    window.addEventListener('atlas-review-finding-notes-updated', handleNotesUpdated as EventListener);
    window.addEventListener(PERSONAL_NOTES_UPDATED_EVENT, handlePersonalNotesUpdated as EventListener);
    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('atlas-review-finding-notes-updated', handleNotesUpdated as EventListener);
      window.removeEventListener(PERSONAL_NOTES_UPDATED_EVENT, handlePersonalNotesUpdated as EventListener);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isOpen, onClose, refreshStoredNotes, selectedHistoricalEntry]);

  const history = useMemo<RecommendationNoteHistoryEntry[]>(() => {
    if (!isOpen) return [];
    return buildProjectRecommendationNoteHistory({
      projectId,
      storageEntries,
      branchReviews,
      workspaceReviews,
      prReviews,
      localBranchNames: localBranches.map((branch) => branch.name),
    });
  }, [isOpen, projectId, storageEntries, branchReviews, workspaceReviews, prReviews, localBranches]);

  const filteredHistory = useMemo(() => {
    if (filter === 'available') return history.filter((entry) => entry.reviewAvailable);
    if (filter === 'unavailable') return history.filter((entry) => !entry.reviewAvailable);
    return history;
  }, [history, filter]);

  const groupedHistory = useMemo(() => {
    const grouped = new Map<string, { key: string; label: string; meta: string | null; entries: RecommendationNoteHistoryEntry[] }>();
    filteredHistory.forEach((entry) => {
      const key = `${entry.reviewType}:${entry.sourceLabel}:${entry.reviewId || entry.storageKey}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.entries.push(entry);
        return;
      }
      grouped.set(key, {
        key,
        label: entry.sourceLabel,
        meta: entry.sourceMeta,
        entries: [entry],
      });
    });
    return Array.from(grouped.values()).sort((left, right) => {
      const leftLatest = Math.max(...left.entries.map((entry) => Date.parse(entry.updatedAt || '') || 0));
      const rightLatest = Math.max(...right.entries.map((entry) => Date.parse(entry.updatedAt || '') || 0));
      return rightLatest - leftLatest;
    });
  }, [filteredHistory]);

  const handleDeleteEntry = useCallback((entry: RecommendationNoteHistoryEntry) => {
    if (typeof window === 'undefined') return;
    const currentProjectId = projectIdRef.current;
    const raw = window.localStorage.getItem(entry.storageKey);
    if (!raw) return;

    let nextNotes;
    try {
      nextNotes = normalizeRecommendationNoteMap(JSON.parse(raw));
    } catch {
      return;
    }

    if (!nextNotes[entry.id]) return;
    delete nextNotes[entry.id];

    if (Object.keys(nextNotes).length === 0) {
      window.localStorage.removeItem(entry.storageKey);
    } else {
      window.localStorage.setItem(entry.storageKey, JSON.stringify(nextNotes));
    }

    if (selectedHistoricalEntry?.storageKey === entry.storageKey && selectedHistoricalEntry?.id === entry.id) {
      setSelectedHistoricalEntry(null);
    }
    setStorageEntries(collectProjectRecommendationNoteStorageEntries({ projectId: currentProjectId }));
    window.dispatchEvent(new CustomEvent('atlas-review-finding-notes-updated'));
    toast.success('Finding note deleted');
  }, [selectedHistoricalEntry]);

  const handleDeleteGroup = useCallback(async (entries: RecommendationNoteHistoryEntry[]) => {
    if (typeof window === 'undefined' || entries.length === 0) return;
    const label = entries[0]?.sourceLabel || 'this review';
    const confirmed = await popup.confirm({
      title: 'Delete notes?',
      message: `Delete all ${entries.length} finding note${entries.length === 1 ? '' : 's'} for ${label}? This cannot be undone.`,
      confirmLabel: entries.length === 1 ? 'Delete note' : 'Delete notes',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;
    const currentProjectId = projectIdRef.current;
    const notesByStorageKey = new Map<string, ReturnType<typeof normalizeRecommendationNoteMap>>();
    let deletedCount = 0;

    for (const entry of entries) {
      let noteMap = notesByStorageKey.get(entry.storageKey);
      if (!noteMap) {
        const raw = window.localStorage.getItem(entry.storageKey);
        if (!raw) continue;
        try {
          noteMap = normalizeRecommendationNoteMap(JSON.parse(raw));
        } catch {
          continue;
        }
        notesByStorageKey.set(entry.storageKey, noteMap);
      }
      if (entry.id in noteMap) {
        delete noteMap[entry.id];
        deletedCount += 1;
      }
    }

    if (notesByStorageKey.size === 0 || deletedCount === 0) return;

    for (const [storageKey, noteMap] of notesByStorageKey.entries()) {
      if (Object.keys(noteMap).length === 0) {
        window.localStorage.removeItem(storageKey);
      } else {
        window.localStorage.setItem(storageKey, JSON.stringify(noteMap));
      }
    }

    if (selectedHistoricalEntry && entries.some((entry) => (
      entry.storageKey === selectedHistoricalEntry.storageKey && entry.id === selectedHistoricalEntry.id
    ))) {
      setSelectedHistoricalEntry(null);
    }
    setStorageEntries(collectProjectRecommendationNoteStorageEntries({ projectId: currentProjectId }));
    window.dispatchEvent(new CustomEvent('atlas-review-finding-notes-updated'));
    toast.success(deletedCount === 1 ? 'Finding note deleted' : `${deletedCount} finding notes deleted`);
  }, [popup, selectedHistoricalEntry]);

  const handleSubmitPersonalNote = useCallback(() => {
    const body = personalNoteDraft.trim();
    if (!body) return;
    const nextNotes = [
      ...personalNotes,
      {
        id: `personal-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        body,
        updatedAt: new Date().toISOString(),
      },
    ];
    writePersonalProjectNotes(projectIdRef.current, nextNotes);
    setPersonalNotes(nextNotes);
    setPersonalNoteDraft('');
    toast.success('Personal note added');
  }, [personalNoteDraft, personalNotes]);

  const handleDeletePersonalNote = useCallback(async (noteId: string) => {
    const nextNotes = personalNotes.filter((note) => note.id !== noteId);
    if (nextNotes.length === personalNotes.length) return;
    writePersonalProjectNotes(projectIdRef.current, nextNotes);
    setPersonalNotes(nextNotes);
    toast.success('Personal note deleted');
  }, [personalNotes]);

  const handleDeleteAllPersonalNotes = useCallback(async () => {
    if (personalNotes.length === 0) return;
    const confirmed = await popup.confirm({
      title: 'Delete notes?',
      message: `Delete all ${personalNotes.length} personal note${personalNotes.length === 1 ? '' : 's'}? This cannot be undone.`,
      confirmLabel: personalNotes.length === 1 ? 'Delete note' : 'Delete notes',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!confirmed) return;
    writePersonalProjectNotes(projectIdRef.current, []);
    setPersonalNotes([]);
    toast.success(personalNotes.length === 1 ? 'Personal note deleted' : `${personalNotes.length} personal notes deleted`);
  }, [personalNotes, popup]);

  if (!isOpen) return null;

  const availableCount = history.filter((entry) => entry.reviewAvailable).length;
  const unavailableCount = history.length - availableCount;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(var(--bg-base-rgb), 0.58)',
        backdropFilter: 'blur(10px)',
        padding: 24,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(920px, 100%)',
          height: 'min(760px, calc(100vh - 48px))',
          maxHeight: 'min(760px, calc(100vh - 48px))',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--review-shell-bg)',
          border: '1px solid var(--review-shell-border-strong)',
          borderRadius: 18,
          boxShadow: 'var(--review-panel-shadow)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--review-shell-divider)',
          background: 'var(--review-panel-header-bg)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div className="review-shell-title" style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                Project Notes
              </div>
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
                Finding notes for {projectName}. Reopen live reviews when available, or inspect saved issue snapshots for historical notes.
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                ...getReviewActionButtonStyle({ tone: 'neutral' }),
                width: 32,
                minHeight: 32,
                padding: 0,
                borderRadius: 999,
                fontSize: 16,
              }}
              title="Close"
            >
              ×
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <ReviewActionButton tone="neutral" active={filter === 'all'} onClick={() => setFilter('all')}>
              All {history.length}
            </ReviewActionButton>
            <ReviewActionButton tone="green" active={filter === 'available'} onClick={() => setFilter('available')}>
              Available {availableCount}
            </ReviewActionButton>
            <ReviewActionButton tone="yellow" active={filter === 'unavailable'} onClick={() => setFilter('unavailable')}>
              Historical {unavailableCount}
            </ReviewActionButton>
          </div>
        </div>

        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'scroll',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}>
          {personalNotes.length > 0 ? (
            <div
              style={{
                flexShrink: 0,
                border: '1px solid var(--review-shell-border)',
                borderRadius: 14,
                background: 'linear-gradient(180deg, rgba(16, 24, 40, 0.96) 0%, rgba(10, 17, 31, 0.96) 100%)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  borderBottom: '1px solid var(--review-shell-divider)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Personal notes</div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    Notes you add here stay attached to this project.
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {personalNotes.length} item{personalNotes.length === 1 ? '' : 's'}
                  </div>
                  <NoteDeleteIconButton
                    title={personalNotes.length === 1 ? 'Delete note' : 'Delete all notes'}
                    onClick={() => {
                      void handleDeleteAllPersonalNotes();
                    }}
                  />
                </div>
              </div>
              <div style={{ padding: '14px 16px 16px' }}>
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: 18,
                    display: 'grid',
                    gap: 10,
                  }}
                >
                  {personalNotes.map((note) => (
                    <li key={note.id} style={{ color: 'var(--text-primary)' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--text-primary)' }}>{note.body}</div>
                          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-tertiary)' }}>
                            {formatUpdatedAt(note.updatedAt)}
                          </div>
                        </div>
                        <NoteDeleteIconButton
                          title="Delete note"
                          onClick={() => {
                            void handleDeletePersonalNote(note.id);
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {loading ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading project notes…</div>
          ) : groupedHistory.length === 0 ? (
            <div style={{
              padding: 18,
              borderRadius: 14,
              border: '1px solid var(--review-shell-border)',
              background: 'var(--review-panel-bg)',
              color: 'var(--text-secondary)',
              fontSize: 13,
            }}>
              No finding notes found for this project yet.
            </div>
          ) : (
            groupedHistory.map((group) => (
              <div
                key={group.key}
                style={{
                  flexShrink: 0,
                  border: '1px solid var(--review-shell-border)',
                  borderRadius: 14,
                  background: 'var(--review-panel-bg)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: '100%',
                    padding: '12px 14px',
                    borderBottom: '1px solid var(--review-shell-divider)',
                    background: 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    textAlign: 'left',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{group.label}</div>
                    {group.meta ? (
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{group.meta}</div>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{group.entries.length} note{group.entries.length === 1 ? '' : 's'}</div>
                    <NoteDeleteIconButton
                      title={`Delete ${group.entries.length === 1 ? 'note' : 'all notes'}`}
                      onClick={() => handleDeleteGroup(group.entries)}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {group.entries.map((entry) => {
                    const target = buildEntryNavigationTarget(entry);
                    const severityLabel = String(entry.findingSeverity || 'low').toUpperCase();
                    return (
                      <div
                        key={`${entry.storageKey}:${entry.id}`}
                        style={{
                          padding: '12px 14px',
                          display: 'grid',
                          gap: 10,
                          borderTop: '1px solid var(--review-shell-divider)',
                          background: 'transparent',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                            <span style={{
                              padding: '2px 8px',
                              borderRadius: 8,
                              background: entry.stale ? 'var(--chip-error-bg)' : 'rgba(212, 175, 55, 0.14)',
                              color: entry.stale ? 'var(--accent-red)' : 'var(--accent-yellow)',
                              fontSize: 10,
                              fontWeight: 800,
                              letterSpacing: '0.04em',
                              fontFamily: 'var(--font-mono)',
                              flexShrink: 0,
                            }}>
                              {severityLabel}
                            </span>
                            <span style={{
                              fontSize: 12,
                              color: 'var(--text-primary)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              minWidth: 0,
                              flex: 1,
                            }}>
                              {entry.findingTitle || 'Saved finding'}
                            </span>
                            <span style={{
                              fontSize: 10,
                              color: 'var(--text-tertiary)',
                              flexShrink: 0,
                            }}>
                              {new Date(entry.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap', justifyContent: 'flex-end', flexShrink: 0 }}>
                            {entry.reviewAvailable ? (
                              <ReviewActionButton
                                tone="blue"
                                disabled={!entry.reviewId}
                                onClick={() => {
                                  if (!entry.reviewId) return;
                                  onOpenNote({
                                    reviewId: entry.reviewId,
                                    reviewType: entry.reviewType,
                                    target,
                                  });
                                  onClose();
                                }}
                              >
                                Open review
                              </ReviewActionButton>
                            ) : (
                              <ReviewActionButton
                                tone="yellow"
                                onClick={() => setSelectedHistoricalEntry(entry)}
                              >
                                Open snapshot
                              </ReviewActionButton>
                            )}
                            {!entry.reviewAvailable && entry.reviewType === 'pr_review' && entry.prHtmlUrl ? (
                              <ReviewActionButton
                                tone="purple"
                                onClick={() => window.open(entry.prHtmlUrl || '', '_blank', 'noopener,noreferrer')}
                              >
                                Open PR
                              </ReviewActionButton>
                            ) : null}
                            <NoteDeleteIconButton
                              title="Delete note"
                              onClick={() => handleDeleteEntry(entry)}
                            />
                          </div>
                        </div>

                        <div style={{
                          fontSize: 11,
                          color: 'var(--accent-blue)',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {entry.locationLabel}
                        </div>

                        {entry.findingDescription ? (
                          <div style={{
                            fontSize: 11,
                            color: 'var(--text-secondary)',
                            lineHeight: 1.45,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}>
                            {entry.findingDescription}
                          </div>
                        ) : null}

                        <div style={{
                          fontSize: 14,
                          color: 'var(--text-primary)',
                          lineHeight: 1.45,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {entry.body}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div
          style={{
            padding: '14px 20px 18px',
            borderTop: '1px solid var(--review-shell-divider)',
            background: 'var(--review-panel-header-bg)',
            display: 'flex',
            alignItems: 'flex-end',
            gap: 12,
          }}
        >
          <textarea
            value={personalNoteDraft}
            onChange={(event) => setPersonalNoteDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSubmitPersonalNote();
              }
            }}
            placeholder="Add a personal note for this project…"
            rows={2}
            style={{
              flex: 1,
              minHeight: 44,
              maxHeight: 120,
              resize: 'vertical',
              borderRadius: 12,
              border: '1px solid var(--review-shell-border)',
              background: 'var(--review-panel-bg)',
              color: 'var(--text-primary)',
              padding: '10px 12px',
              fontSize: 13,
              lineHeight: 1.5,
              outline: 'none',
            }}
          />
          <ReviewActionButton
            tone="blue"
            disabled={!personalNoteDraft.trim()}
            onClick={handleSubmitPersonalNote}
          >
            Save
          </ReviewActionButton>
        </div>
      </div>

      {selectedHistoricalEntry ? (
        <div
          onClick={() => setSelectedHistoricalEntry(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(var(--bg-base-rgb), 0.64)',
            backdropFilter: 'blur(12px)',
            padding: 24,
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 'min(760px, 100%)',
              maxHeight: 'min(720px, calc(100vh - 48px))',
              overflow: 'auto',
              display: 'grid',
              gap: 16,
              background: 'var(--review-shell-bg)',
              border: '1px solid var(--review-shell-border-strong)',
              borderRadius: 18,
              boxShadow: 'var(--review-panel-shadow)',
              padding: 24,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
              <div>
                <div className="review-shell-title" style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                  Historical Finding Snapshot
                </div>
                <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
                  {selectedHistoricalEntry.sourceLabel}
                  {selectedHistoricalEntry.sourceMeta ? ` · ${selectedHistoricalEntry.sourceMeta}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedHistoricalEntry(null)}
                style={{
                  ...getReviewActionButtonStyle({ tone: 'neutral' }),
                  width: 32,
                  minHeight: 32,
                  padding: 0,
                  borderRadius: 999,
                  fontSize: 16,
                }}
                title="Close snapshot"
              >
                ×
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <ReviewActionButton tone="yellow" active>
                Historical
              </ReviewActionButton>
              <ReviewActionButton tone="neutral" active>
                {String(selectedHistoricalEntry.findingSeverity || 'low').toUpperCase()}
              </ReviewActionButton>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{selectedHistoricalEntry.locationLabel}</span>
              {selectedHistoricalEntry.staleReason ? (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>• {selectedHistoricalEntry.staleReason}</span>
              ) : null}
            </div>

            <div style={{
              padding: 14,
              borderRadius: 14,
              border: '1px solid var(--review-shell-border)',
              background: 'var(--review-card-bg)',
              display: 'grid',
              gap: 8,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
                Note
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.6 }}>
                {selectedHistoricalEntry.body}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {formatUpdatedAt(selectedHistoricalEntry.updatedAt)}
              </div>
            </div>

            <div style={{
              padding: 14,
              borderRadius: 14,
              border: '1px solid var(--review-shell-border)',
              background: 'var(--review-panel-bg)',
              display: 'grid',
              gap: 10,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
                Saved finding
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.45 }}>
                {selectedHistoricalEntry.findingTitle || 'Saved finding'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)' }}>
                {selectedHistoricalEntry.locationLabel}
              </div>
              {selectedHistoricalEntry.findingDescription ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  {selectedHistoricalEntry.findingDescription}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  No saved finding description was available for this note, but the note body and anchor metadata are preserved.
                </div>
              )}
              {selectedHistoricalEntry.evidenceSnippet ? (
                <pre style={{
                  margin: 0,
                  padding: 12,
                  borderRadius: 12,
                  background: 'var(--bg-base)',
                  border: '1px solid var(--review-shell-border)',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                  lineHeight: 1.6,
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {selectedHistoricalEntry.evidenceSnippet}
                </pre>
              ) : null}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              {selectedHistoricalEntry.reviewType === 'pr_review' && selectedHistoricalEntry.prHtmlUrl ? (
                <ReviewActionButton
                  tone="purple"
                  onClick={() => window.open(selectedHistoricalEntry.prHtmlUrl || '', '_blank', 'noopener,noreferrer')}
                >
                  Open PR
                </ReviewActionButton>
              ) : null}
              <NoteDeleteIconButton
                title="Delete note"
                onClick={() => handleDeleteEntry(selectedHistoricalEntry)}
              />
              <ReviewActionButton
                tone="neutral"
                onClick={() => setSelectedHistoricalEntry(null)}
              >
                Close
              </ReviewActionButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
