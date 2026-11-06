import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/queries.js', () => ({
  getProjectById: vi.fn(),
  createMemorySnapshot: vi.fn(),
  getProjectMemorySnapshots: vi.fn().mockResolvedValue([]),
  updateProjectMemory: vi.fn(),
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (_req, _res, next) => next(),
}));

import { getProjectById } from '../../db/queries.js';
import agentInstructionsRouter from '../agentInstructions.js';
import memoryService from '../../services/memoryService.js';
import {
  default as agentInstructionService,
  removeAtlasInstructionBlock,
  replaceAtlasInstructionBlock,
  previewInstructions,
  removeInstructions,
  resolveInstructionFilePath,
  writeInstructions,
} from '../../services/agentInstructionService.js';

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

describe('agentInstructionService', () => {
  let projectRoot;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-agent-instructions-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('previews deterministic Atlas MCP guidance for supported targets', async () => {
    const result = await previewInstructions({
      projectPath: projectRoot,
      projectName: 'AtlasEngineMVP',
      targets: ['codex', 'cursor', 'copilot'],
    });

    expect(result.instructionBlock).toContain('atlas_review_wait_for_terminal');
    expect(result.instructionBlock).toContain('atlas_review_outcome_get');
    expect(result.instructionBlock).toContain('the user explicitly asks to use Atlas review');
    expect(result.instructionBlock).toContain('Do not use Atlas MCP just because code changes are complete');
    expect(result.instructionBlock).not.toContain('code changes are ready for review');
    expect(result.instructionBlock).toContain('Do not cancel a running review based on elapsed time alone');
    expect(result.instructionBlock).toContain('When the user asks for a PR review, always use explicit PR targeting');
    expect(result.instructionBlock).toContain('PR review execution through `atlas_review_run_current` is queue-only');
    expect(result.instructionBlock).toContain('Do not claim an Atlas finding is fixed until its outcome has been persisted');
    expect(result.previews.map((entry) => entry.target)).toEqual(['codex', 'cursor', 'copilot']);
    expect(result.previews[0].filePath).toBe(path.join(projectRoot, 'AGENTS.md'));
    expect(result.previews[2].filePath).toBe(path.join(projectRoot, '.github', 'copilot-instructions.md'));
  });

  it('writes instruction files idempotently and creates backups only for existing files', async () => {
    const firstWrite = await writeInstructions({
      projectPath: projectRoot,
      projectName: 'AtlasEngineMVP',
      targets: ['codex'],
      dryRun: false,
    });

    expect(firstWrite.results[0]).toEqual(expect.objectContaining({
      target: 'codex',
      changed: true,
      created: true,
      backupPath: null,
    }));

    const filePath = path.join(projectRoot, 'AGENTS.md');
    const firstContent = await fs.readFile(filePath, 'utf8');
    expect(firstContent).toContain('atlas_review_wait_for_terminal');

    const secondWrite = await writeInstructions({
      projectPath: projectRoot,
      projectName: 'AtlasEngineMVP',
      targets: ['codex'],
      dryRun: false,
    });

    expect(secondWrite.results[0]).toEqual(expect.objectContaining({
      target: 'codex',
      changed: false,
      created: false,
      backupPath: null,
    }));
    const secondContent = await fs.readFile(filePath, 'utf8');
    expect(secondContent).toBe(firstContent);
  });

  it('removes only the Atlas sentinel block and keeps surrounding content with backup', async () => {
    const targetPath = path.join(projectRoot, 'AGENTS.md');
    await fs.writeFile(
      targetPath,
      [
        '# Team Notes',
        '',
        'Keep this header.',
        '',
        '<!-- atlas-review-mcp:start -->',
        'temporary atlas block',
        '<!-- atlas-review-mcp:end -->',
        '',
        'Tail content stays.',
        '',
      ].join('\n'),
      'utf8'
    );

    const result = await removeInstructions({
      projectPath: projectRoot,
      targets: ['codex'],
      dryRun: false,
    });

    expect(result.results[0]).toEqual(expect.objectContaining({
      target: 'codex',
      changed: true,
      removed: true,
      backupPath: null,
    }));

    const updated = await fs.readFile(targetPath, 'utf8');
    expect(updated).toContain('# Team Notes');
    expect(updated).toContain('Tail content stays.');
    expect(updated).not.toContain('atlas-review-mcp:start');
  });

  it('replaces every Atlas sentinel block occurrence with a single canonical block', () => {
    const next = replaceAtlasInstructionBlock(
      [
        '# Notes',
        '',
        '<!-- atlas-review-mcp:start -->',
        'old block one',
        '<!-- atlas-review-mcp:end -->',
        '',
        'middle',
        '',
        '<!-- atlas-review-mcp:start -->',
        'old block two',
        '<!-- atlas-review-mcp:end -->',
        '',
      ].join('\n'),
      [
        '<!-- atlas-review-mcp:start -->',
        'canonical block',
        '<!-- atlas-review-mcp:end -->',
      ].join('\n')
    );

    expect(next.match(/atlas-review-mcp:start/g)).toHaveLength(1);
    expect(next).toContain('canonical block');
    expect(next).not.toContain('old block one');
    expect(next).not.toContain('old block two');
  });

  it('removes every Atlas sentinel block occurrence from a document', () => {
    const removed = removeAtlasInstructionBlock(
      [
        'before',
        '',
        '<!-- atlas-review-mcp:start -->',
        'old block one',
        '<!-- atlas-review-mcp:end -->',
        '',
        'between',
        '',
        '<!-- atlas-review-mcp:start -->',
        'old block two',
        '<!-- atlas-review-mcp:end -->',
        '',
        'after',
      ].join('\n')
    );

    expect(removed.changed).toBe(true);
    expect(removed.content).toContain('before');
    expect(removed.content).toContain('between');
    expect(removed.content).toContain('after');
    expect(removed.content).not.toContain('atlas-review-mcp:start');
    expect(removed.content).not.toContain('old block two');
  });

  it('supports dry-run without mutating files', async () => {
    const result = await writeInstructions({
      projectPath: projectRoot,
      projectName: 'AtlasEngineMVP',
      targets: ['cursor'],
      dryRun: true,
    });

    expect(result.results[0]).toEqual(expect.objectContaining({
      target: 'cursor',
      changed: true,
      created: true,
      dryRun: true,
      backupPath: null,
    }));
    await expect(fs.stat(path.join(projectRoot, '.cursorrules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deduplicates targets that resolve to the same instruction file', async () => {
    const result = await previewInstructions({
      projectPath: projectRoot,
      projectName: 'AtlasEngineMVP',
      targets: ['copilot', 'vscode'],
    });

    expect(result.previews).toHaveLength(1);
    expect(result.previews[0].target).toBe('copilot');
    expect(result.previews[0].relativeFilePath).toBe(path.join('.github', 'copilot-instructions.md'));
  });

  it('collects per-target write failures without aborting earlier successes', async () => {
    const originalWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (filePath, data, encoding) => {
      if (String(filePath).endsWith('.cursorrules')) {
        throw new Error('disk full');
      }
      return originalWriteFile(filePath, data, encoding);
    });

    const result = await writeInstructions({
      projectPath: projectRoot,
      projectName: 'AtlasEngineMVP',
      targets: ['codex', 'cursor'],
      dryRun: false,
    });

    expect(result.results).toEqual([
      expect.objectContaining({ target: 'codex', changed: true, created: true }),
    ]);
    expect(result.failures).toEqual([
      expect.objectContaining({ target: 'cursor', error: 'disk full' }),
    ]);
    await expect(fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8')).resolves.toContain('atlas_review_wait_for_terminal');
    await expect(fs.stat(path.join(projectRoot, '.cursorrules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('upserts and removes Atlas-managed Claude guidance while preserving surrounding memory content', async () => {
    const claudePath = path.join(projectRoot, 'CLAUDE.md');
    await fs.writeFile(claudePath, [
      '# Project Memory',
      '',
      '## Coding Conventions',
      '- Keep service boundaries explicit',
      '',
      '---',
      '*This file is automatically managed by AtlasEngine\'s memory system*',
      '*Last memory snapshot: 2026-03-11T00:00:00.000Z*',
      '',
    ].join('\n'), 'utf8');

    const firstUpsert = await memoryService.upsertAtlasClaudeGuidance(
      'proj-1',
      projectRoot,
      'AtlasEngineMVP',
      ANONYMOUS_USER_ID,
      { dryRun: false }
    );
    expect(firstUpsert.result).toEqual(expect.objectContaining({
      target: 'claude',
      changed: true,
      created: false,
      backupPath: null,
    }));

    const withGuidance = await fs.readFile(claudePath, 'utf8');
    expect(withGuidance).toContain('atlas-review-mcp:claude:start');
    expect(withGuidance).toContain('Keep service boundaries explicit');
    expect(withGuidance.match(/atlas-review-mcp:claude:start/g)).toHaveLength(1);

    const secondUpsert = await memoryService.upsertAtlasClaudeGuidance(
      'proj-1',
      projectRoot,
      'AtlasEngineMVP',
      ANONYMOUS_USER_ID,
      { dryRun: false }
    );
    expect(secondUpsert.result.changed).toBe(false);

    const removal = await memoryService.removeAtlasClaudeGuidance(
      'proj-1',
      projectRoot,
      ANONYMOUS_USER_ID,
      { dryRun: false }
    );
    expect(removal.result).toEqual(expect.objectContaining({
      target: 'claude',
      changed: true,
      removed: true,
      backupPath: null,
    }));

    const removedContent = await fs.readFile(claudePath, 'utf8');
    expect(removedContent).toContain('Keep service boundaries explicit');
    expect(removedContent).not.toContain('atlas-review-mcp:claude:start');
  });

  it('recomputes Claude guidance content from the initialized CLAUDE.md when creating a new file', async () => {
    const generateTemplateSpy = vi.spyOn(memoryService, 'generateTemplate');
    generateTemplateSpy
      .mockImplementationOnce(() => '# Project: stale template\n')
      .mockImplementationOnce(() => '# Project: initialized template\n');

    const result = await memoryService.upsertAtlasClaudeGuidance(
      'proj-1',
      projectRoot,
      'AtlasEngineMVP',
      ANONYMOUS_USER_ID,
      { dryRun: false }
    );

    expect(result.result).toEqual(expect.objectContaining({
      target: 'claude',
      changed: true,
      created: true,
      backupPath: null,
    }));

    const content = await fs.readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('# Project: initialized template');
    expect(content).not.toContain('# Project: stale template');
    expect(content).toContain('atlas-review-mcp:claude:start');
  });

  it('rejects instruction file paths that escape the project root', () => {
    expect(() => resolveInstructionFilePath(projectRoot, '../escape.md')).toThrow(/escapes project root/u);
  });
});

describe('agentInstructionsRouter', () => {
  let projectRoot;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-agent-instructions-route-'));
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      name: 'AtlasEngineMVP',
      path: projectRoot,
    });
  });

  it('returns preview content for project-scoped targets', async () => {
    const { req, res } = createMockReqRes({
      query: { targets: 'codex,cursor' },
    });

    await callRouteHandler(agentInstructionsRouter, 'get', '/proj-1/agent-instructions/preview', req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      instructionBlock: expect.stringContaining('atlas_review_wait_for_terminal'),
      previews: expect.arrayContaining([
        expect.objectContaining({ target: 'codex' }),
        expect.objectContaining({ target: 'cursor' }),
      ]),
    }));
  });

  it('supports Claude preview and generate through the shared route contract', async () => {
    const preview = createMockReqRes({
      query: { targets: 'claude,codex' },
    });
    await callRouteHandler(agentInstructionsRouter, 'get', '/proj-1/agent-instructions/preview', preview.req, preview.res);

    expect(preview.res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      previews: [
        expect.objectContaining({ target: 'claude', relativeFilePath: 'CLAUDE.md' }),
        expect.objectContaining({ target: 'codex', relativeFilePath: 'AGENTS.md' }),
      ],
    }));

    const create = createMockReqRes({
      body: { targets: ['claude', 'codex'], dryRun: false },
    });
    await callRouteHandler(agentInstructionsRouter, 'post', '/proj-1/agent-instructions', create.req, create.res);

    expect(create.res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      results: [
        expect.objectContaining({ target: 'claude', relativeFilePath: 'CLAUDE.md' }),
        expect.objectContaining({ target: 'codex', relativeFilePath: 'AGENTS.md' }),
      ],
    }));
    await expect(fs.readFile(path.join(projectRoot, 'CLAUDE.md'), 'utf8')).resolves.toContain('atlas-review-mcp:claude:start');
    await expect(fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8')).resolves.toContain('atlas_review_wait_for_terminal');
  });

  it('generates instruction files through the route and then removes them', async () => {
    const create = createMockReqRes({
      body: { targets: ['codex'], dryRun: false },
    });
    await callRouteHandler(agentInstructionsRouter, 'post', '/proj-1/agent-instructions', create.req, create.res);

    expect(create.res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      results: [expect.objectContaining({ target: 'codex', changed: true, created: true })],
    }));
    expect(await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8')).toContain('atlas_review_wait_for_terminal');

    const remove = createMockReqRes({
      body: { targets: ['codex'], dryRun: false },
    });
    await callRouteHandler(agentInstructionsRouter, 'delete', '/proj-1/agent-instructions', remove.req, remove.res);

    expect(remove.res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      results: [expect.objectContaining({ target: 'codex', changed: true, removed: true })],
      failures: [],
    }));
    await expect(fs.stat(path.join(projectRoot, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns partial failures from the route instead of aborting the whole request', async () => {
    const originalWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (filePath, data, encoding) => {
      if (String(filePath).endsWith('.cursorrules')) {
        throw new Error('disk full');
      }
      return originalWriteFile(filePath, data, encoding);
    });

    const create = createMockReqRes({
      body: { targets: ['codex', 'cursor'], dryRun: false },
    });
    await callRouteHandler(agentInstructionsRouter, 'post', '/proj-1/agent-instructions', create.req, create.res);

    expect(create.res.status).not.toHaveBeenCalled();
    expect(create.res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      results: [expect.objectContaining({ target: 'codex', changed: true })],
      failures: [expect.objectContaining({ target: 'cursor', error: 'disk full' })],
    }));
  });

  it('sorts partial failures even when a failure is missing its target', async () => {
    vi.spyOn(agentInstructionService, 'writeInstructions').mockResolvedValue({
      instructionBlock: 'atlas block',
      results: [{ target: 'codex', changed: true, created: true }],
      failures: [{ error: 'missing target metadata' }],
    });

    const create = createMockReqRes({
      body: { targets: ['codex', 'cursor'], dryRun: false },
    });
    await callRouteHandler(agentInstructionsRouter, 'post', '/proj-1/agent-instructions', create.req, create.res);

    expect(create.res.status).not.toHaveBeenCalled();
    expect(create.res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      failures: [expect.objectContaining({ error: 'missing target metadata' })],
    }));
  });

  it('validates missing targets and rejects unauthorized access', async () => {
    const missingTargets = createMockReqRes({ body: {} });
    await callRouteHandler(agentInstructionsRouter, 'post', '/proj-1/agent-instructions', missingTargets.req, missingTargets.res);
    expect(missingTargets.res.status).toHaveBeenCalledWith(400);
    expect(missingTargets.res.json).toHaveBeenCalledWith({ error: 'At least one instruction target is required' });

    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      user_id: 'different-user',
      name: 'AtlasEngineMVP',
      path: projectRoot,
    });
    const forbidden = createMockReqRes({
      body: { targets: ['codex'] },
    });
    await callRouteHandler(agentInstructionsRouter, 'post', '/proj-1/agent-instructions', forbidden.req, forbidden.res);
    expect(forbidden.res.status).toHaveBeenCalledWith(403);
    expect(forbidden.res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
  });
});

function createMockReqRes({
  params = {},
  body = {},
  query = {},
  user = null,
} = {}) {
  const req = {
    params,
    body,
    query,
    user,
  };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  };
  return { req, res };
}

async function callRouteHandler(router, method, pathName, req, res) {
  const stack = router.stack;
  const pathParts = pathName.split('/').filter(Boolean);

  for (const layer of stack) {
    if (!layer.route) continue;
    const routePath = layer.route.path;
    const routeMethod = Object.keys(layer.route.methods)[0];
    if (routeMethod !== method) continue;

    const routeParts = routePath.split('/').filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;

    let match = true;
    const extractedParams = {};
    for (let i = 0; i < routeParts.length; i += 1) {
      if (routeParts[i].startsWith(':')) {
        extractedParams[routeParts[i].slice(1)] = pathParts[i];
      } else if (routeParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    req.params = { ...req.params, ...extractedParams };
    const handlers = layer.route.stack.map((entry) => entry.handle);
    for (const handler of handlers) {
      await new Promise((resolve, reject) => {
        const next = (err) => (err ? reject(err) : resolve());
        const result = handler(req, res, next);
        if (result instanceof Promise) {
          result.then(resolve).catch(reject);
        }
      });
    }
    return;
  }

  throw new Error(`Route not found: ${method} ${pathName}`);
}
