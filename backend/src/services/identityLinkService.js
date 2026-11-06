/**
 * identityLinkService
 *
 * Links a guest (anonymous desktop) user to their GitHub identity, with
 * merge-on-conflict semantics so the same GitHub account across devices
 * collapses into a single `users` row.
 *
 * Exports:
 *   - linkGuestToGithub({ currentUserId, accessToken })
 *     Case A: no prior user → update current row with GitHub profile
 *     Case B: GitHub already linked to a different user → merge current into
 *             existing and re-point sync/usage tables in one transaction
 *     Case C: GitHub already linked to current user → refresh profile, no-op
 *
 *   - unlinkGithub(userId)
 *     Nulls GitHub fields and resets email to the guest placeholder so the
 *     row can be used as an anonymous guest again. History stays attached.
 */

import db, { transaction, getDbType } from '../db/connection.js';

const GITHUB_USER_ENDPOINT = 'https://api.github.com/user';

export async function fetchGithubUser(accessToken) {
  const response = await fetch(GITHUB_USER_ENDPOINT, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `token ${accessToken}`,
      'User-Agent': 'AtlasEngine',
    },
  });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.message || body?.error || '';
    } catch { /* noop */ }
    throw new Error(
      `Failed to fetch GitHub user profile (status ${response.status})${detail ? `: ${detail}` : ''}`
    );
  }

  const payload = await response.json();
  const githubUserId = Number(payload?.id);
  if (!Number.isFinite(githubUserId) || githubUserId <= 0) {
    throw new Error('GitHub profile response missing numeric id');
  }

  return {
    id: githubUserId,
    login: typeof payload.login === 'string' ? payload.login : null,
    avatarUrl: typeof payload.avatar_url === 'string' ? payload.avatar_url : null,
    email: typeof payload.email === 'string' ? payload.email : null,
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : null,
  };
}

// Display name preferred when replacing the auto-generated "Device XXXXXXXX" label.
function pickDisplayName(profile) {
  return profile.name || profile.login || null;
}

function guestEmailFor(userId) {
  const short = String(userId || '').slice(0, 8);
  return `guest-${short}@device.atlasengine.local`;
}

function nowExpr() {
  return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
}

// A swallowable failure during the merge re-point: the table or its `user_id`
// column does not exist in this database's schema. Deliberately narrow — a
// bare `does not exist` test would also swallow type/operator/function/role/
// sequence errors ("operator does not exist: text = uuid", "function f() does
// not exist", ...), masking real bugs. Only these shapes count:
//   SQLite:   "no such table: x" / "no such column: x"
//   Postgres: 'relation "x" does not exist'
//             'column "x" does not exist'
//             'column "x" of relation "y" does not exist' (contains the
//              'relation "y" does not exist' fragment, so it matches too)
function isSchemaShapeMismatch(err) {
  const message = err?.message || '';
  return (
    /no such table|no such column/i.test(message) ||
    /relation .+ does not exist/i.test(message) ||
    /column .+ does not exist/i.test(message)
  );
}

/**
 * Run `fn` inside a transaction-local SAVEPOINT so a swallowable failure can
 * be caught WITHOUT poisoning the surrounding transaction.
 *
 * Postgres aborts the *entire* transaction on any statement error
 * ("current transaction is aborted, commands ignored until end of
 * transaction block"), so a bare try/catch around a mid-transaction
 * statement silently breaks everything that follows. The previous merge code
 * hit this every time it touched a table lacking a `user_id` column (e.g.
 * `chat_stream_state`): the first error was swallowed, then every later
 * statement — including the final `UPDATE users` / `DELETE FROM users` —
 * failed with "transaction is aborted" and the whole merge rolled back.
 *
 * SAVEPOINT / ROLLBACK TO SAVEPOINT / RELEASE SAVEPOINT are valid on both
 * SQLite and Postgres, so one code path covers both backends.
 *
 * @returns {Promise<boolean>} true if `fn` succeeded; false if it failed with
 *   an error matched by `isIgnorable` (transaction left usable); rethrows
 *   anything else.
 */
async function withSavepoint(client, name, fn, isIgnorable = isSchemaShapeMismatch) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return true;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
    if (isIgnorable(err)) return false;
    throw err;
  }
}

/**
 * Link a guest user to their GitHub identity.
 *
 * @param {Object} params
 * @param {string} params.currentUserId - id of the row currently used by the desktop session
 * @param {string} params.accessToken - OAuth access token for GitHub
 * @returns {Promise<{ userId: string, merged: boolean }>}
 */
export async function linkGuestToGithub({ currentUserId, accessToken } = {}) {
  if (!currentUserId) throw new Error('currentUserId is required');
  if (!accessToken) throw new Error('accessToken is required');

  const profile = await fetchGithubUser(accessToken);
  const result = await linkGuestToGithubProfile({ currentUserId, profile });
  return { ...result, profile };
}

/**
 * DB-only variant of linkGuestToGithub. Accepts a pre-fetched GitHub profile
 * so upstream callers (e.g. the Railway-side identity-sync endpoint) can
 * reuse the same merge/refresh logic without re-hitting the GitHub API.
 *
 * @param {Object} params
 * @param {string} params.currentUserId
 * @param {{ id: number, login?: string|null, avatarUrl?: string|null, email?: string|null, name?: string|null }} params.profile
 * @returns {Promise<{ userId: string, merged: boolean }>}
 */
export async function linkGuestToGithubProfile({ currentUserId, profile } = {}) {
  if (!currentUserId) throw new Error('currentUserId is required');
  if (!profile || !Number.isFinite(Number(profile.id)) || Number(profile.id) <= 0) {
    throw new Error('profile.id is required and must be a positive number');
  }
  profile = {
    id: Number(profile.id),
    login: profile.login ?? null,
    avatarUrl: profile.avatarUrl ?? null,
    email: profile.email ?? null,
    name: (typeof profile.name === 'string' && profile.name.trim()) ? profile.name.trim() : null,
  };
  const emailForRow = profile.email || null;

  // Look up any user already linked to this GitHub account.
  const existing = await db.query(
    'SELECT id FROM users WHERE github_user_id = $1 LIMIT 1',
    [profile.id]
  );
  const existingId = existing.rows?.[0]?.id || null;

  const displayName = pickDisplayName(profile);

  // Only replace the name if it's still the auto-generated "Device ..." fallback
  // (or NULL) — don't overwrite a label the user has intentionally customized.
  const nameUpdateExpr = displayName
    ? "CASE WHEN name IS NULL OR name LIKE 'Device %' THEN $NAME ELSE name END"
    : 'name';

  // Case C: already linked to the same user — refresh profile fields only.
  if (existingId && existingId === currentUserId) {
    const params = [profile.login, profile.avatarUrl, profile.id, emailForRow];
    let sql = `UPDATE users
          SET github_login = $1,
              github_avatar_url = $2,
              github_user_id = $3,
              email = COALESCE($4, email),`;
    if (displayName) {
      params.push(displayName);
      sql += `\n              name = ${nameUpdateExpr.replace('$NAME', `$${params.length}`)},`;
    }
    params.push(currentUserId);
    sql += `\n              updated_at = ${nowExpr()}
        WHERE id = $${params.length}`;
    await db.query(sql, params);
    return { userId: currentUserId, merged: false };
  }

  // Case A: no prior linked user — stamp profile onto current row.
  if (!existingId) {
    const params = [profile.login, profile.avatarUrl, profile.id, emailForRow];
    let sql = `UPDATE users
          SET github_login = $1,
              github_avatar_url = $2,
              github_user_id = $3,
              email = COALESCE($4, email),`;
    if (displayName) {
      params.push(displayName);
      sql += `\n              name = ${nameUpdateExpr.replace('$NAME', `$${params.length}`)},`;
    }
    params.push(currentUserId);
    sql += `\n              updated_at = ${nowExpr()}
        WHERE id = $${params.length}`;
    await db.query(sql, params);
    return { userId: currentUserId, merged: false };
  }

  // Case B: merge current into existing in one transaction.
  await transaction(async (client) => {
    // Re-point every table whose user_id FKs back to users(id) so that the
    // DELETE at the end of this transaction doesn't cascade-delete or
    // SET NULL any history that belonged to the guest. `review_sync_events`
    // and `review_sync_sessions` use TEXT user_id (no hard FK) but still
    // reference the same identity; included for parity.
    //
    // Each UPDATE runs inside its own SAVEPOINT: table/column shape differs
    // across desktop installs and optional features, and on Postgres a
    // failed statement aborts the whole transaction unless rolled back to a
    // savepoint first (see withSavepoint).
    const tablesToRepoint = [
      'review_sync_events',
      'review_sync_sessions',
      'usage_ledger',
      'projects',
      'builds',
      'previews',
      'memory_snapshots',
      'sessions',
      'chat_messages',
      'github_integrations',
      'supabase_integrations',
      'events',
    ];
    for (const table of tablesToRepoint) {
      await withSavepoint(client, `repoint_${table}`, () =>
        client.query(`UPDATE ${table} SET user_id = $1 WHERE user_id = $2`, [existingId, currentUserId])
      );
    }

    // user_quotas is a PRIMARY KEY on user_id, so we can't just re-point.
    // Accumulate counters from the guest row into the existing row, then
    // delete the guest row. If the target has no quota row (trigger should
    // have created one, but defend against missing triggers), fall back to
    // re-pointing the source row instead of losing its counters. Wrapped in
    // a SAVEPOINT because the desktop SQLite `user_quotas` schema is leaner
    // than Postgres's (it may lack cost/requests/builds columns) — a column
    // mismatch must not poison the rest of the merge.
    await withSavepoint(client, 'merge_user_quotas', async () => {
      const guestQuota = await client.query(
        'SELECT * FROM user_quotas WHERE user_id = $1',
        [currentUserId]
      );
      const targetQuota = await client.query(
        'SELECT user_id FROM user_quotas WHERE user_id = $1',
        [existingId]
      );
      if (guestQuota.rows.length === 0) return;
      if (targetQuota.rows.length === 0) {
        await client.query(
          'UPDATE user_quotas SET user_id = $1 WHERE user_id = $2',
          [existingId, currentUserId]
        );
        return;
      }
      const g = guestQuota.rows[0];
      await client.query(
        `UPDATE user_quotas
            SET tokens_used_this_month = tokens_used_this_month + $1,
                cost_this_month = cost_this_month + $2,
                requests_this_hour = requests_this_hour + $3,
                builds_today = builds_today + $4,
                quota_exceeded = quota_exceeded OR $5,
                updated_at = ${nowExpr()}
          WHERE user_id = $6`,
        [
          Number(g.tokens_used_this_month) || 0,
          Number(g.cost_this_month) || 0,
          Number(g.requests_this_hour) || 0,
          Number(g.builds_today) || 0,
          // SQLite uses 0/1 for booleans and rejects true/false bindings.
          g.quota_exceeded ? 1 : 0,
          existingId,
        ]
      );
      await client.query(
        'DELETE FROM user_quotas WHERE user_id = $1',
        [currentUserId]
      );
    });

    // Refresh the existing row's profile fields.
    const params = [profile.login, profile.avatarUrl, emailForRow];
    let sql = `UPDATE users
          SET github_login = $1,
              github_avatar_url = $2,
              email = COALESCE($3, email),`;
    if (displayName) {
      params.push(displayName);
      sql += `\n              name = ${nameUpdateExpr.replace('$NAME', `$${params.length}`)},`;
    }
    params.push(existingId);
    sql += `\n              updated_at = ${nowExpr()}
        WHERE id = $${params.length}`;
    await client.query(sql, params);
    await client.query('DELETE FROM users WHERE id = $1', [currentUserId]);
  });

  return { userId: existingId, merged: true };
}

/**
 * Reset a user row back to guest state. GitHub identity is cleared but the
 * row (and all history keyed on its id) is preserved.
 *
 * @param {string} userId
 * @returns {Promise<{ userId: string, unlinked: true }>}
 */
export async function unlinkGithub(userId) {
  if (!userId) throw new Error('userId is required');

  const guestEmail = guestEmailFor(userId);

  await db.query(
    `UPDATE users
        SET github_login = NULL,
            github_avatar_url = NULL,
            github_user_id = NULL,
            email = $1,
            updated_at = ${nowExpr()}
      WHERE id = $2`,
    [guestEmail, userId]
  );

  return { userId, unlinked: true };
}

export default {
  fetchGithubUser,
  linkGuestToGithub,
  linkGuestToGithubProfile,
  unlinkGithub,
};
