import db, { getDbType } from '../../db/connection.js';

const BRANCH_AUTO_REVIEW_SUPPRESSION_PREFIX = 'branch_auto_review_suppressed:';

function normalizeSha(value) {
  return String(value || '').trim();
}

function getSuppressionKey(branchReviewId) {
  return `${BRANCH_AUTO_REVIEW_SUPPRESSION_PREFIX}${branchReviewId}`;
}

function getCurrentSnapshot(review, diffStats = null) {
  return {
    headSha: normalizeSha(diffStats?.headSha || review?.headSha),
    mergeBaseSha: normalizeSha(diffStats?.mergeBaseSha || review?.mergeBaseSha),
    baseBranch: String(review?.baseBranch || '').trim(),
  };
}

function parseSuppressionValue(rawValue) {
  if (rawValue == null) return null;
  try {
    const parsed = JSON.parse(String(rawValue));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      headSha: normalizeSha(parsed.headSha),
      mergeBaseSha: normalizeSha(parsed.mergeBaseSha),
      baseBranch: String(parsed.baseBranch || '').trim(),
      reason: String(parsed.reason || '').trim(),
      stoppedAt: String(parsed.stoppedAt || '').trim(),
    };
  } catch {
    return null;
  }
}

function getSettingsUpsertSql() {
  if (getDbType() === 'sqlite') {
    return `INSERT INTO settings (id, value, updated_at)
      VALUES ($1, $2, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')`;
  }

  return `INSERT INTO settings (id, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT(id) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()`;
}

export async function suppressBranchAutoReviewForSnapshot(review, options = {}) {
  if (!review?.id) return false;

  const snapshot = getCurrentSnapshot(review, options.snapshot || options.diffStats || null);
  if (!snapshot.headSha) {
    console.warn(
      `[branchAutoReviewSuppression] Cannot suppress auto-review for ${review.id}: no head SHA available.`
    );
    return false;
  }

  const payload = JSON.stringify({
    ...snapshot,
    reason: options.reason || 'user_stopped_review',
    stoppedAt: new Date().toISOString(),
  });
  await db.query(getSettingsUpsertSql(), [getSuppressionKey(review.id), payload]);
  return true;
}

export async function isBranchAutoReviewSuppressedForSnapshot(review, diffStats = null) {
  if (!review?.id) return false;

  const snapshot = getCurrentSnapshot(review, diffStats);
  if (!snapshot.headSha) return false;

  const result = await db.query('SELECT value FROM settings WHERE id = $1', [getSuppressionKey(review.id)]);
  const suppression = parseSuppressionValue(result.rows[0]?.value);
  if (!suppression?.headSha) return false;

  if (suppression.headSha !== snapshot.headSha) return false;
  if (suppression.mergeBaseSha || snapshot.mergeBaseSha) {
    return suppression.mergeBaseSha === snapshot.mergeBaseSha;
  }
  return suppression.baseBranch === snapshot.baseBranch;
}
