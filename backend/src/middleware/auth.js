/**
 * Authentication Middleware
 *
 * Provides JWT-based auth for the admin dashboard and future SaaS flows.
 * Backwards-compatible: existing routes continue working without auth
 * (anonymous user fallback is preserved).
 */

import jwt from 'jsonwebtoken';

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

export function extractBearerToken(authHeader) {
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7).trim();
  return token || null;
}

export function verifyJWTToken(token) {
  if (!token) {
    return null;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.warn('JWT_SECRET not configured — skipping token verification');
    return null;
  }

  try {
    const decoded = jwt.verify(token, secret);
    if (!decoded || typeof decoded !== 'object' || !decoded.id) {
      return null;
    }

    return {
      id: decoded.id,
      email: decoded.email,
      is_admin: decoded.is_admin || false,
      plan: decoded.plan,
    };
  } catch {
    return null;
  }
}

/**
 * Extract and verify JWT from Authorization header.
 * If valid, attaches decoded payload to req.user.
 * If no token or invalid, falls through without error (backwards-compatible).
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
export function authenticateJWT(req, res, next) {
  const user = verifyJWTToken(extractBearerToken(req.headers.authorization));
  if (user) {
    req.user = user;
  }

  next();
}

/**
 * Require a valid authenticated user. Returns 401 if not authenticated.
 * Must be chained after authenticateJWT.
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
export function requireAuth(req, res, next) {
  if (!req.user || req.user.id === ANONYMOUS_USER_ID) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

/**
 * Require admin role. Returns 403 if not admin.
 * Must be chained after authenticateJWT + requireAuth.
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
