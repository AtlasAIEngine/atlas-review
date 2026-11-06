/**
 * Migration 008: Expand review_outcomes scope to PR reviews
 *
 * The baseline review_outcomes schema only allowed changeset and branch_review
 * scopes. PR review outcomes were added later at the route/service layer, so
 * existing databases need the constraint widened to accept `pr_review`.
 */

export const version = 8;
export const name = 'review_outcomes_pr_scope';

const postgresSQL = `
ALTER TABLE review_outcomes
  DROP CONSTRAINT IF EXISTS review_outcomes_review_type_check;

ALTER TABLE review_outcomes
  ADD CONSTRAINT review_outcomes_review_type_check
  CHECK (review_type IN ('changeset', 'branch_review', 'pr_review'));
`;

const sqliteSQL = `
DROP TRIGGER IF EXISTS trg_review_outcomes_validate_insert;
DROP TRIGGER IF EXISTS trg_review_outcomes_validate_update;

CREATE TRIGGER IF NOT EXISTS trg_review_outcomes_validate_insert
BEFORE INSERT ON review_outcomes
FOR EACH ROW
WHEN NEW.review_type NOT IN ('changeset', 'branch_review', 'pr_review')
  OR NEW.status NOT IN ('addressed', 'dismissed')
BEGIN
  SELECT RAISE(ABORT, 'review_outcomes constraint violation');
END;

CREATE TRIGGER IF NOT EXISTS trg_review_outcomes_validate_update
BEFORE UPDATE ON review_outcomes
FOR EACH ROW
WHEN NEW.review_type NOT IN ('changeset', 'branch_review', 'pr_review')
  OR NEW.status NOT IN ('addressed', 'dismissed')
BEGIN
  SELECT RAISE(ABORT, 'review_outcomes constraint violation');
END;
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
