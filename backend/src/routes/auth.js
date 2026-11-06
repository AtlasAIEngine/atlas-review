/**
 * Auth Routes
 *
 * Handles login, session verification, and admin user seeding
 * for the admin dashboard.
 */

import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { findUserByEmail, findUserById, updateUserLastLogin } from '../db/queries.js';
import { query, getDbType } from '../db/connection.js';
import { authenticateJWT, requireAuth } from '../middleware/auth.js';
import { fetchGithubUser } from '../services/identityLinkService.js';

const router = express.Router();

const JWT_EXPIRY = '24h';
const SALT_ROUNDS = 12;

function getJwtSecret() {
  return process.env.JWT_SECRET;
}

function getAdminSetupToken() {
  return String(process.env.ADMIN_SETUP_TOKEN || '').trim();
}

/**
 * POST /api/auth/login
 * Authenticate with email/password, returns JWT
 */
router.post('/login', async (req, res) => {
  try {
    if (!getJwtSecret()) {
      return res.status(500).json({ error: 'Auth not configured (JWT_SECRET missing)' });
    }

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await findUserByEmail(email);
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated' });
    }

    await updateUserLastLogin(user.id);

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        is_admin: user.is_admin || false,
        plan: user.plan,
      },
      getJwtSecret(),
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        is_admin: user.is_admin || false,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * GET /api/auth/me
 * Returns current user profile from JWT
 */
router.get('/me', authenticateJWT, requireAuth, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        is_admin: user.is_admin || false,
        created_at: user.created_at,
        last_login: user.last_login,
      },
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * POST /api/auth/setup-admin
 * One-time admin user creation. Only works when no admin users exist.
 */
router.post('/setup-admin', async (req, res) => {
  try {
    if (!getJwtSecret()) {
      return res.status(500).json({ error: 'Auth not configured (JWT_SECRET missing)' });
    }

    const setupToken = getAdminSetupToken();
    const providedToken = String(req.headers['x-admin-setup-token'] || '').trim();
    if (!setupToken || providedToken !== setupToken) {
      return res.status(403).json({ error: 'Setup not allowed' });
    }

    // Check if any admin already exists
    const existing = await query(
      'SELECT id FROM users WHERE is_admin = TRUE LIMIT 1'
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Admin user already exists' });
    }

    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Check if user with this email exists
    const existingUser = await findUserByEmail(email);
    let userId;

    if (existingUser) {
      // Promote existing user to admin
      await query(
        'UPDATE users SET password_hash = $1, is_admin = TRUE, name = COALESCE($2, name) WHERE id = $3',
        [passwordHash, name, existingUser.id]
      );
      userId = existingUser.id;
    } else {
      // Create new admin user
      const isSqlite = getDbType() === 'sqlite';
      const id = isSqlite ? randomUUID() : null;
      const result = id
        ? await query(
            `INSERT INTO users (id, email, password_hash, name, plan, is_admin)
             VALUES ($1, $2, $3, $4, 'pro', TRUE)
             RETURNING id`,
            [id, email, passwordHash, name || 'Admin']
          )
        : await query(
            `INSERT INTO users (email, password_hash, name, plan, is_admin)
             VALUES ($1, $2, $3, 'pro', TRUE)
             RETURNING id`,
            [email, passwordHash, name || 'Admin']
          );
      userId = result.rows[0].id;
    }

    const token = jwt.sign(
      { id: userId, email, is_admin: true, plan: 'pro' },
      getJwtSecret(),
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      success: true,
      message: 'Admin user created',
      token,
    });
  } catch (error) {
    console.error('Setup admin error:', error);
    res.status(500).json({ error: 'Failed to setup admin' });
  }
});

/**
 * POST /api/auth/change-password
 * Change the current admin's email and/or password.
 * Requires valid JWT auth.
 */
router.post('/change-password', authenticateJWT, requireAuth, async (req, res) => {
  try {
    const { current_password, new_password, new_email } = req.body;

    if (!current_password) {
      return res.status(400).json({ error: 'Current password is required' });
    }
    if (!new_password && !new_email) {
      return res.status(400).json({ error: 'Provide new_password and/or new_email' });
    }

    const user = await findUserById(req.user.id);
    if (!user || !user.password_hash) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const updates = [];
    const params = [];
    let paramIdx = 1;

    if (new_password) {
      const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
      updates.push(`password_hash = $${paramIdx}`);
      params.push(hash);
      paramIdx++;
    }

    if (new_email) {
      updates.push(`email = $${paramIdx}`);
      params.push(new_email);
      paramIdx++;
    }

    params.push(req.user.id);
    await query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = ${getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()'}
       WHERE id = $${paramIdx}`,
      params
    );

    res.json({ success: true, message: 'Credentials updated' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to update credentials' });
  }
});

/**
 * POST /api/auth/github
 * Authenticate via GitHub OAuth token.
 * Fetches the GitHub user profile, finds the matching user by github_user_id,
 * and issues a JWT.
 */
router.post('/github', async (req, res) => {
  try {
    if (!getJwtSecret()) {
      return res.status(500).json({ error: 'Auth not configured (JWT_SECRET missing)' });
    }

    const { access_token } = req.body;
    if (!access_token) {
      return res.status(400).json({ error: 'GitHub access_token is required' });
    }

    let ghUser;
    try {
      ghUser = await fetchGithubUser(access_token);
    } catch {
      return res.status(401).json({ error: 'Invalid GitHub token' });
    }

    if (!ghUser.login || !ghUser.id) {
      return res.status(401).json({ error: 'Could not resolve GitHub identity' });
    }

    let result = await query(
      'SELECT * FROM users WHERE github_user_id = $1 AND is_active = TRUE LIMIT 1',
      [ghUser.id]
    );

    if (result.rows.length === 0) {
      result = await query(
        'SELECT * FROM users WHERE github_login = $1 AND is_active = TRUE LIMIT 1',
        [ghUser.login]
      );
    }

    if (result.rows.length === 0) {
      return res.status(403).json({
        error: 'No AtlasEngine account linked to this GitHub identity. Connect GitHub from the desktop app first.',
        github_login: ghUser.login,
      });
    }

    const user = result.rows[0];
    if (!user.github_user_id) {
      const conflict = await query(
        'SELECT id FROM users WHERE github_user_id = $1 AND id != $2 LIMIT 1',
        [ghUser.id, user.id]
      );
      if (conflict.rows.length === 0) {
        await query(
          `UPDATE users
           SET github_user_id = $1,
               github_login = $2,
               github_avatar_url = $3,
               updated_at = ${getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()'}
           WHERE id = $4 AND github_user_id IS NULL`,
          [ghUser.id, ghUser.login, ghUser.avatarUrl, user.id]
        );
        user.github_user_id = ghUser.id;
        user.github_login = ghUser.login;
        user.github_avatar_url = ghUser.avatarUrl;
      }
    }

    await updateUserLastLogin(user.id);

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        is_admin: user.is_admin || false,
        plan: user.plan,
        github_login: ghUser.login,
      },
      getJwtSecret(),
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        is_admin: user.is_admin || false,
        github_login: ghUser.login,
        github_avatar_url: ghUser.avatarUrl,
      },
    });
  } catch (error) {
    console.error('GitHub auth error:', error);
    res.status(500).json({ error: 'GitHub authentication failed' });
  }
});

export default router;
