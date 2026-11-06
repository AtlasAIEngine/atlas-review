/**
 * Admin Routes
 *
 * Protected routes for the admin dashboard.
 * All routes require JWT auth + admin role.
 */

import express from 'express';
import { authenticateJWT, requireAuth, requireAdmin } from '../middleware/auth.js';
import * as adminService from '../services/adminService.js';

const router = express.Router();

// All admin routes require authentication + admin role
router.use(authenticateJWT, requireAuth, requireAdmin);

// ============================================================================
// OVERVIEW
// ============================================================================

router.get('/overview', async (req, res) => {
  try {
    const metrics = await adminService.getOverviewMetrics({ range: req.query.range });
    res.json({ success: true, metrics });
  } catch (error) {
    console.error('Admin overview error:', error);
    res.status(500).json({ error: 'Failed to get overview metrics' });
  }
});

// ============================================================================
// USERS
// ============================================================================

router.get('/users', async (req, res) => {
  try {
    const { page, limit, search, plan, sort, order } = req.query;
    const result = await adminService.getUsers({
      page: parseInt(page, 10) || 1,
      limit: Math.min(parseInt(limit, 10) || 50, 100),
      search,
      plan,
      sort,
      order,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const user = await adminService.getUserDetail(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ success: true, user });
  } catch (error) {
    console.error('Admin user detail error:', error);
    res.status(500).json({ error: 'Failed to get user detail' });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const user = await adminService.updateUser(req.params.id, req.body);
    if (!user) {
      return res.status(404).json({ error: 'User not found or no valid fields' });
    }
    res.json({ success: true, user });
  } catch (error) {
    console.error('Admin update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ============================================================================
// PROJECTS
// ============================================================================

router.get('/projects', async (req, res) => {
  try {
    const { page, limit, search, status, sort, order } = req.query;
    const result = await adminService.getProjects({
      page: parseInt(page, 10) || 1,
      limit: Math.min(parseInt(limit, 10) || 50, 100),
      search,
      status,
      sort,
      order,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Admin projects error:', error);
    res.status(500).json({ error: 'Failed to get projects' });
  }
});

// ============================================================================
// REVIEWS
// ============================================================================

router.get('/reviews/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const summary = await adminService.getReviewSummary({ from, to });
    res.json({ success: true, summary });
  } catch (error) {
    console.error('Admin review summary error:', error);
    res.status(500).json({ error: 'Failed to get review summary' });
  }
});

router.get('/reviews/timeseries', async (req, res) => {
  try {
    const { from, to, interval } = req.query;
    const data = await adminService.getReviewTimeseries({ from, to, interval });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin review timeseries error:', error);
    res.status(500).json({ error: 'Failed to get review timeseries' });
  }
});

router.get('/reviews/insights', async (req, res) => {
  try {
    const insights = await adminService.getReviewInsights();
    res.json({ success: true, insights });
  } catch (error) {
    console.error('Admin review insights error:', error);
    res.status(500).json({ error: 'Failed to get review insights' });
  }
});

// ============================================================================
// USAGE
// ============================================================================

router.get('/usage/summary', async (req, res) => {
  try {
    const { from, to } = req.query;
    const data = await adminService.getUsageSummary({ from, to });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin usage summary error:', error);
    res.status(500).json({ error: 'Failed to get usage summary' });
  }
});

router.get('/usage/timeseries', async (req, res) => {
  try {
    const { from, to, interval } = req.query;
    const data = await adminService.getUsageTimeseries({ from, to, interval });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin usage timeseries error:', error);
    res.status(500).json({ error: 'Failed to get usage timeseries' });
  }
});

router.get('/usage/top-users', async (req, res) => {
  try {
    const { by, limit, from, to } = req.query;
    const data = await adminService.getTopUsers({
      by,
      limit: Math.min(parseInt(limit, 10) || 10, 50),
      from,
      to,
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin top users error:', error);
    res.status(500).json({ error: 'Failed to get top users' });
  }
});

// ============================================================================
// BUILDS
// ============================================================================

router.get('/builds/stats', async (req, res) => {
  try {
    const { from, to } = req.query;
    const stats = await adminService.getBuildStats({ from, to });
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Admin build stats error:', error);
    res.status(500).json({ error: 'Failed to get build stats' });
  }
});

// ============================================================================
// EVENTS
// ============================================================================

router.get('/events', async (req, res) => {
  try {
    const { page, limit, kind, status } = req.query;
    const result = await adminService.getEvents({
      page: parseInt(page, 10) || 1,
      limit: Math.min(parseInt(limit, 10) || 50, 100),
      kind,
      status,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Admin events error:', error);
    res.status(500).json({ error: 'Failed to get events' });
  }
});

// ============================================================================
// REVIEW SYNC
// ============================================================================

router.post('/review-sync/reassign-session', async (req, res) => {
  try {
    const { session_user_id, target_user_id } = req.body;
    if (!session_user_id || !target_user_id) {
      return res.status(400).json({ error: 'session_user_id and target_user_id required' });
    }
    const { query } = await import('../db/connection.js');
    await query(
      'UPDATE review_sync_sessions SET user_id = $1 WHERE user_id = $2',
      [target_user_id, session_user_id]
    );
    res.json({ success: true, message: `Reassigned sessions from ${session_user_id} to ${target_user_id}` });
  } catch (error) {
    console.error('Admin reassign session error:', error);
    res.status(500).json({ error: 'Failed to reassign session' });
  }
});

router.get('/review-sync/stats', async (req, res) => {
  try {
    const stats = await adminService.getReviewSyncStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Admin review sync stats error:', error);
    res.status(500).json({ error: 'Failed to get review sync stats' });
  }
});

export default router;
