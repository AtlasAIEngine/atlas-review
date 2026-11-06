import type { PopupContextValue } from '@/components/shared/PopupProvider';
import { PARTIAL_MODE_MAX_FILES_HINT } from '@/constants/reviewPartialMode';

/**
 * Pre-flight popup that lets the user choose between a partial (top-N
 * highest-risk files) or full review on a large branch diff. Returns the
 * selected mode, or `null` when the user dismisses the popup.
 *
 * Both `TrustReviewPanel.handleReviewNow` and
 * `TrustReviewView.handleBannerReviewNow` call this so the title, message
 * copy, and option keys/labels stay in sync across entry points.
 */
export async function askPartialOrFull(
  popup: PopupContextValue,
  branchFileCount: number,
): Promise<'partial' | 'full' | null> {
  return popup.choose<'partial' | 'full'>({
    title: 'Large diff — partial review recommended',
    message: `This branch has ${branchFileCount} files. Atlas can review the top ${PARTIAL_MODE_MAX_FILES_HINT} highest-risk files now and defer the rest, or run a full review (may take 15+ minutes). You can re-run partial later to cover the deferred files.`,
    options: [
      { key: 'full', label: 'Run full review', tone: 'secondary' },
      { key: 'partial', label: 'Partial (recommended)', tone: 'primary' },
    ],
  });
}
