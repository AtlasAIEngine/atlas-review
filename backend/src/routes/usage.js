/**
 * Usage Routes
 * API endpoints for review usage tracking, monthly summaries,
 * and free tier limit status.
 */

import express from 'express';
import usageService from '../services/usageService.js';

const router = express.Router();

/**
 * GET /api/usage/summary
 * Get current month's usage summary (review count, tokens, cost, limit status)
 */
router.get('/summary', async (req, res) => {
  try {
    const summary = await usageService.getCurrentMonthSummary();
    res.json({ success: true, ...summary });
  } catch (error) {
    console.error('Error getting usage summary:', error);
    res.status(500).json({ error: 'Failed to get usage summary' });
  }
});

/**
 * GET /api/usage/recent
 * Get recent review usage records
 * Query params: limit (default 20), projectId (optional), reviewType (optional), reviewId (optional)
 */
router.get('/recent', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const projectId = req.query.projectId || undefined;
    const reviewType = req.query.reviewType || undefined;
    const reviewId = req.query.reviewId || undefined;

    const records = await usageService.getRecentUsage({ limit, projectId, reviewType, reviewId });
    res.json({ success: true, records, count: records.length });
  } catch (error) {
    console.error('Error getting recent usage:', error);
    res.status(500).json({ error: 'Failed to get recent usage' });
  }
});

/**
 * GET /api/usage/breakdown
 * Get cost breakdown by provider/model for current month
 */
router.get('/breakdown', async (req, res) => {
  try {
    const breakdown = await usageService.getProviderBreakdown();
    res.json({ success: true, breakdown });
  } catch (error) {
    console.error('Error getting usage breakdown:', error);
    res.status(500).json({ error: 'Failed to get usage breakdown' });
  }
});

/**
 * GET /api/usage/limit-status
 * Quick check if the free tier limit has been reached
 */
router.get('/limit-status', async (req, res) => {
  try {
    const summary = await usageService.getCurrentMonthSummary();
    res.json({
      success: true,
      used: summary.reviewCount,
      limit: summary.monthlyLimit,
      remaining: summary.reviewsRemaining,
      limitReached: summary.limitReached,
    });
  } catch (error) {
    console.error('Error getting limit status:', error);
    res.status(500).json({ error: 'Failed to get limit status' });
  }
});

export default router;
