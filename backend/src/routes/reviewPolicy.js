import fs from 'node:fs/promises';
import path from 'node:path';

import express from 'express';

import { getProjectById } from '../db/queries.js';
import { enforceQuotas } from '../middleware/quotas.js';
import projectInitService from '../services/projectInitService.js';
import {
  createDefaultReviewPolicyDocument,
  ensureGeneratedProjectReviewPolicy,
  normalizeRepoPolicyDocument,
  parseReviewPolicyContent,
} from '../services/review/reviewPolicyService.js';
import { detectLinterStatus } from '../services/review/linter/linterDetection.js';

const router = express.Router();

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const REVIEW_POLICY_RELATIVE_PATH = '.atlas/review-policy.json';

function getEffectiveUserId(req) {
  return req.user?.id || ANONYMOUS_USER_ID;
}

function checkOwnership(project, req) {
  return project?.user_id === getEffectiveUserId(req);
}

function getReviewPolicyPath(projectPath) {
  return path.join(projectPath, '.atlas', 'review-policy.json');
}

async function writeNormalizedReviewPolicy(projectPath, parsedDocument) {
  await projectInitService.ensureReviewPolicyTrackable(projectPath);
  await fs.mkdir(path.join(projectPath, '.atlas'), { recursive: true });
  const normalizedContent = `${JSON.stringify(normalizeRepoPolicyDocument(parsedDocument), null, 2)}\n`;
  await fs.writeFile(getReviewPolicyPath(projectPath), normalizedContent, 'utf8');
  return normalizedContent;
}

function buildReviewPolicyResponse(projectPath, {
  content,
  exists,
  contentSource,
  defaultContent = null,
  starterPolicy = null,
} = {}) {
  const resolvedStarterPolicy = starterPolicy || createDefaultReviewPolicyDocument(projectPath);
  const resolvedDefaultContent = defaultContent || `${JSON.stringify(resolvedStarterPolicy, null, 2)}\n`;
  const parsedContent = parseReviewPolicyContent(content);
  return {
    success: true,
    exists,
    path: REVIEW_POLICY_RELATIVE_PATH,
    content,
    defaultContent: resolvedDefaultContent,
    contentSource,
    normalizedPolicy: parsedContent.policy,
    contentParseError: parsedContent.error,
    starterPolicy: resolvedStarterPolicy,
    linterStatus: detectLinterStatus(projectPath),
  };
}

router.get('/:id/review-policy', enforceQuotas, async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const starterPolicy = createDefaultReviewPolicyDocument(project.path);
    const defaultContent = `${JSON.stringify(starterPolicy, null, 2)}\n`;
    const generatedPolicy = await ensureGeneratedProjectReviewPolicy(project);
    const filePath = getReviewPolicyPath(project.path);

    try {
      const content = await fs.readFile(filePath, 'utf8');
      return res.json(buildReviewPolicyResponse(project.path, {
        content,
        exists: true,
        contentSource: 'saved',
        defaultContent,
        starterPolicy,
      }));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      return res.json(buildReviewPolicyResponse(project.path, {
        content: generatedPolicy.content || defaultContent,
        exists: false,
        contentSource: generatedPolicy.policy ? 'generated' : 'starter',
        defaultContent,
        starterPolicy,
      }));
    }
  } catch (error) {
    console.error('Error loading review policy:', error);
    return res.status(500).json({ error: 'Failed to load review policy' });
  }
});

router.put('/:id/review-policy', enforceQuotas, async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!content.trim()) {
      return res.status(400).json({ error: 'Review policy content is required' });
    }

    let parsedDocument;
    try {
      parsedDocument = JSON.parse(content);
    } catch (error) {
      return res.status(400).json({
        error: 'Review policy must be valid JSON',
        details: error?.message || 'Failed to parse JSON',
      });
    }

    if (!parsedDocument || typeof parsedDocument !== 'object' || Array.isArray(parsedDocument)) {
      return res.status(400).json({ error: 'Review policy must be a JSON object' });
    }

    const normalizedContent = await writeNormalizedReviewPolicy(project.path, parsedDocument);
    const starterPolicy = createDefaultReviewPolicyDocument(project.path);
    const defaultContent = `${JSON.stringify(starterPolicy, null, 2)}\n`;
    return res.json(buildReviewPolicyResponse(project.path, {
      content: normalizedContent,
      exists: true,
      contentSource: 'saved',
      defaultContent,
      starterPolicy,
    }));
  } catch (error) {
    console.error('Error saving review policy:', error);
    return res.status(500).json({ error: 'Failed to save review policy' });
  }
});

router.post('/:id/review-policy/reset', enforceQuotas, async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const starterPolicy = createDefaultReviewPolicyDocument(project.path);
    const defaultContent = `${JSON.stringify(starterPolicy, null, 2)}\n`;
    const generatedPolicy = await ensureGeneratedProjectReviewPolicy(project);
    const resetDocument = generatedPolicy.policy || starterPolicy;
    const normalizedContent = await writeNormalizedReviewPolicy(project.path, resetDocument);
    return res.json(buildReviewPolicyResponse(project.path, {
      content: normalizedContent,
      exists: true,
      contentSource: 'saved',
      defaultContent,
      starterPolicy,
    }));
  } catch (error) {
    console.error('Error resetting review policy:', error);
    return res.status(500).json({ error: 'Failed to reset review policy' });
  }
});

export default router;
