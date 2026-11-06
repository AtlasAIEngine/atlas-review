/**
 * RisksSection — Layer 3: Risk flags + recommendation list.
 * Extracted from TrustReviewPanel.tsx.
 */

import type {
  ReviewResult,
  ReviewRecommendation,
  ChangeSetRiskFlags,
} from '@/types';
import type { DiffNavigationTarget } from '@/utils/reviewNavigation';
import type {
  RecommendationNoteDraft,
  RecommendationResolutionState,
  RecommendationFixStatusMap,
  RecommendationResolutionMap,
  RecommendationNoteMap,
  RecommendationVerificationState,
} from './reviewPanelUtils';
import {
  getRecommendationFingerprint,
  getRecommendationResolutionFor,
  getRecommendationVerificationState,
} from './reviewPanelUtils';
import { RecommendationItem } from './RecommendationItem';

export function RisksSection({
  review,
  riskFlags,
  includeResolved,
  expandedRecs,
  selectedRecommendationIndex,
  recommendationResolutions,
  recommendationFixStatuses,
  recommendationNotes,
  canManageNotes = false,
  onSetRecommendationResolution,
  onClearRecommendationResolution,
  onEditRecommendationNote,
  onClearRecommendationNote,
  onMarkRecommendationStillOpen,
  onRunVerificationReview,
  onAskAgent,
  onSelectRecommendation,
  onJumpToRecommendation,
  onToggleRec,
}: {
  review: ReviewResult;
  riskFlags?: ChangeSetRiskFlags;
  includeResolved: boolean;
  expandedRecs: Set<number>;
  selectedRecommendationIndex: number;
  recommendationResolutions: RecommendationResolutionMap;
  recommendationFixStatuses?: RecommendationFixStatusMap;
  recommendationNotes?: RecommendationNoteMap;
  canManageNotes?: boolean;
  onSetRecommendationResolution: (rec: ReviewRecommendation, state: RecommendationResolutionState, note?: string) => void;
  onClearRecommendationResolution: (rec: ReviewRecommendation) => void;
  onEditRecommendationNote?: (rec: ReviewRecommendation) => void;
  onClearRecommendationNote?: (rec: ReviewRecommendation) => void;
  onMarkRecommendationStillOpen?: (rec: ReviewRecommendation) => void;
  onRunVerificationReview?: (rec: ReviewRecommendation) => void;
  onAskAgent?: (rec: ReviewRecommendation) => void;
  onSelectRecommendation: (index: number) => void;
  onJumpToRecommendation: (index: number, target: DiffNavigationTarget | null, rec: ReviewRecommendation) => void;
  onToggleRec: (index: number) => void;
}) {
  // Active risk flags
  const activeFlags: Array<{ key: string; label: string }> = [];
  if (riskFlags) {
    if (riskFlags.dependencyChanges) activeFlags.push({ key: 'dep', label: 'Dependency changes detected' });
    if (riskFlags.envChanges) activeFlags.push({ key: 'env', label: 'Environment config modified' });
    if (riskFlags.buildConfigChanges) activeFlags.push({ key: 'build', label: 'Build configuration changed' });
    if (riskFlags.largeBlastRadius) activeFlags.push({ key: 'blast', label: `Large blast radius (${riskFlags.fileCount} files)` });
  }

  const visibleRecommendations = review.recommendations.filter((rec) => {
    if (rec.type === 'praise') return false;
    if (includeResolved) return true;
    return !getRecommendationResolutionFor(rec, recommendationResolutions);
  });
  const visibleIssues = visibleRecommendations.filter((rec) => rec.type === 'issue');
  const visibleSuggestions = visibleRecommendations.filter((rec) => rec.type === 'suggestion');

  const renderRecommendationGroup = (
    title: string,
    description: string | null,
    recommendations: ReviewRecommendation[],
  ) => {
    if (recommendations.length === 0) return null;

    return (
      <div style={{ marginBottom: 'var(--space-3)' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          marginBottom: 'var(--space-2)',
          flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
              {title} ({recommendations.length})
            </span>
            {description && (
              <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                {description}
              </span>
            )}
          </div>
        </div>
        {recommendations.map((rec) => {
          const index = review.recommendations.indexOf(rec);
          const resolution = getRecommendationResolutionFor(rec, recommendationResolutions);
          const fixStatus = recommendationFixStatuses?.[getRecommendationFingerprint(rec)]?.status || null;
          const note: RecommendationNoteDraft | null = recommendationNotes?.[getRecommendationFingerprint(rec)] || null;
          const verificationState: RecommendationVerificationState | null = getRecommendationVerificationState({
            resolution,
            fixStatus,
          });
          return (
            <RecommendationItem
              key={index}
              index={index}
              rec={rec}
              resolution={resolution}
              fixStatus={fixStatus}
              verificationState={verificationState}
              note={note}
              canManageNote={canManageNotes && rec.type === 'issue'}
              isExpanded={expandedRecs.has(index)}
              isSelected={selectedRecommendationIndex === index}
              onSetResolution={onSetRecommendationResolution}
              onClearResolution={onClearRecommendationResolution}
              onEditNote={onEditRecommendationNote}
              onClearNote={onClearRecommendationNote}
              onMarkStillOpen={onMarkRecommendationStillOpen}
              onRunVerificationReview={onRunVerificationReview}
              onAskAgent={onAskAgent}
              onSelect={() => onSelectRecommendation(index)}
              onJump={(target) => onJumpToRecommendation(index, target, rec)}
              onToggle={() => onToggleRec(index)}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div>
      {/* Risk flags */}
      {activeFlags.length > 0 && (
        <div style={{ marginBottom: 'var(--space-2)' }}>
          {activeFlags.map(flag => (
            <div
              key={flag.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: 'var(--space-1) 0',
                fontSize: 'var(--text-xs)',
                color: 'var(--accent-yellow)',
              }}
            >
              <span style={{ fontSize: 12 }}>{'\u26A0'}</span>
              <span>{flag.label}</span>
            </div>
          ))}
        </div>
      )}

      {renderRecommendationGroup('Issues', null, visibleIssues)}
      {renderRecommendationGroup('Suggestions', 'Lower-risk improvements and follow-up items.', visibleSuggestions)}

      {visibleRecommendations.length === 0 && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', padding: 'var(--space-2) 0' }}>
          {includeResolved ? 'No recommendations' : 'No unresolved recommendations'}
        </div>
      )}
    </div>
  );
}
