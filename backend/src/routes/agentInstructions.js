import express from 'express';
import { getProjectById } from '../db/queries.js';
import { enforceQuotas } from '../middleware/quotas.js';
import agentInstructionService from '../services/agentInstructionService.js';
import memoryService from '../services/memoryService.js';

const router = express.Router();

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const CLAUDE_TARGET = 'claude';

function getEffectiveUserId(req) {
  return req.user?.id || ANONYMOUS_USER_ID;
}

function checkOwnership(project, req) {
  return project?.user_id === getEffectiveUserId(req);
}

function normalizeTargetsInput(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

router.get('/:id/agent-instructions/preview', enforceQuotas, async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const normalizedTargets = normalizeTargetsInput(req.query.targets);
    if (normalizedTargets.length === 0) {
      return res.status(400).json({ error: 'At least one instruction target is required' });
    }

    const { claudeSelected, standardTargets } = splitInstructionTargets(normalizedTargets);
    const previews = [];
    let instructionBlock = null;

    if (standardTargets.length > 0) {
      const result = await agentInstructionService.previewInstructions({
        projectPath: project.path,
        targets: standardTargets,
      });
      instructionBlock = result.instructionBlock;
      previews.push(...result.previews);
    }

    if (claudeSelected) {
      const result = await memoryService.previewAtlasClaudeGuidance(project.path);
      instructionBlock ||= result.instructionBlock;
      previews.push(result.preview);
    }

    return res.json({
      success: true,
      instructionBlock: instructionBlock || '',
      previews: sortInstructionEntries(previews, normalizedTargets),
    });
  } catch (error) {
    if (isInstructionValidationError(error)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error previewing agent instructions:', error);
    return res.status(500).json({ error: 'Failed to preview agent instructions' });
  }
});

router.post('/:id/agent-instructions', enforceQuotas, async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const normalizedTargets = normalizeTargetsInput(req.body?.targets);
    if (normalizedTargets.length === 0) {
      return res.status(400).json({ error: 'At least one instruction target is required' });
    }

    const { claudeSelected, standardTargets } = splitInstructionTargets(normalizedTargets);
    const results = [];
    const failures = [];
    let instructionBlock = null;

    if (standardTargets.length > 0) {
      const result = await agentInstructionService.writeInstructions({
        projectPath: project.path,
        targets: standardTargets,
        dryRun: req.body?.dryRun === true,
      });
      instructionBlock = result.instructionBlock;
      results.push(...result.results);
      failures.push(...result.failures);
    }

    if (claudeSelected) {
      const result = await memoryService.upsertAtlasClaudeGuidance(
        project.id,
        project.path,
        project.name,
        getEffectiveUserId(req),
        { dryRun: req.body?.dryRun === true }
      );
      instructionBlock ||= result.instructionBlock;
      results.push(result.result);
      failures.push(...result.failures);
    }

    return res.json({
      success: true,
      instructionBlock: instructionBlock || '',
      results: sortInstructionEntries(results, normalizedTargets),
      failures: sortInstructionEntries(failures, normalizedTargets),
    });
  } catch (error) {
    if (isInstructionValidationError(error)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error generating agent instructions:', error);
    return res.status(500).json({ error: 'Failed to generate agent instructions' });
  }
});

router.delete('/:id/agent-instructions', enforceQuotas, async (req, res) => {
  try {
    const project = await getProjectById(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const normalizedTargets = normalizeTargetsInput(req.body?.targets);
    if (normalizedTargets.length === 0) {
      return res.status(400).json({ error: 'At least one instruction target is required' });
    }

    const { claudeSelected, standardTargets } = splitInstructionTargets(normalizedTargets);
    const results = [];
    const failures = [];

    if (standardTargets.length > 0) {
      const result = await agentInstructionService.removeInstructions({
        projectPath: project.path,
        targets: standardTargets,
        dryRun: req.body?.dryRun === true,
      });
      results.push(...result.results);
      failures.push(...result.failures);
    }

    if (claudeSelected) {
      const result = await memoryService.removeAtlasClaudeGuidance(
        project.id,
        project.path,
        getEffectiveUserId(req),
        { dryRun: req.body?.dryRun === true }
      );
      results.push(result.result);
      failures.push(...result.failures);
    }

    return res.json({
      success: true,
      results: sortInstructionEntries(results, normalizedTargets),
      failures: sortInstructionEntries(failures, normalizedTargets),
    });
  } catch (error) {
    if (isInstructionValidationError(error)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error removing agent instructions:', error);
    return res.status(500).json({ error: 'Failed to remove agent instructions' });
  }
});

function isInstructionValidationError(error) {
  const message = String(error?.message || '');
  return (
    message.includes('instruction target')
    || message.includes('Project path is required')
    || message.includes('Instruction file path is required')
    || message.includes('escapes project root')
  );
}

function splitInstructionTargets(normalizedTargets) {
  return {
    claudeSelected: normalizedTargets.includes(CLAUDE_TARGET),
    standardTargets: normalizedTargets.filter((target) => target !== CLAUDE_TARGET),
  };
}

function sortInstructionEntries(entries, requestedTargets) {
  if (entries.length === 0) {
    return entries;
  }
  const order = new Map(requestedTargets.map((target, index) => [target, index]));
  return [...entries].sort((left, right) => {
    const leftIndex = left?.target != null ? (order.get(left.target) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const rightIndex = right?.target != null ? (order.get(right.target) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}

export default router;
