/**
 * Migration 018: SQLite review_outcomes integrity triggers
 *
 * SQLite path in migration 016 could not express CHECK constraints in-place
 * for pre-existing tables. Add write-time validation triggers so status and
 * review_type match the same contract enforced in PostgreSQL.
 */

export const version = 18;
export const name = 'review_outcomes_sqlite_constraints';

export const up = {
  postgres: `
    SELECT 1;
  `,
  sqlite: `
    CREATE TRIGGER IF NOT EXISTS trg_review_outcomes_validate_insert
    BEFORE INSERT ON review_outcomes
    FOR EACH ROW
    WHEN NEW.review_type NOT IN ('changeset', 'branch_review')
      OR NEW.status NOT IN ('addressed', 'dismissed')
    BEGIN
      SELECT RAISE(ABORT, 'review_outcomes constraint violation');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_review_outcomes_validate_update
    BEFORE UPDATE ON review_outcomes
    FOR EACH ROW
    WHEN NEW.review_type NOT IN ('changeset', 'branch_review')
      OR NEW.status NOT IN ('addressed', 'dismissed')
    BEGIN
      SELECT RAISE(ABORT, 'review_outcomes constraint violation');
    END;
  `,
};

export default {
  version,
  name,
  up,
};
