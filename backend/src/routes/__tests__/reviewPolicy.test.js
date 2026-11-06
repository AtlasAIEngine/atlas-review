import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/queries.js', () => ({
  getProjectById: vi.fn(),
  updateProjectGeneratedReviewPolicy: vi.fn(),
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (_req, _res, next) => next(),
}));

import { getProjectById } from '../../db/queries.js';
import { updateProjectGeneratedReviewPolicy } from '../../db/queries.js';
import reviewPolicyRouter from '../reviewPolicy.js';

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

describe('reviewPolicyRouter', () => {
  let projectRoot;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-review-policy-route-'));
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      name: 'Atlas Test Project',
      path: projectRoot,
      user_id: ANONYMOUS_USER_ID,
      generated_review_policy_json: null,
    });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('returns generated default content when the project policy file does not exist yet', async () => {
    const { req, res } = createReqRes({ params: { id: 'proj-1' } });

    await callRouteHandler(reviewPolicyRouter, 'get', '/proj-1/review-policy', req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      exists: false,
      path: '.atlas/review-policy.json',
      contentSource: 'generated',
    }));
    expect(() => JSON.parse(res.body.content)).not.toThrow();
    expect(res.body.starterPolicy).toEqual(expect.objectContaining({
      version: 1,
    }));
    expect(res.body.normalizedPolicy).toEqual(expect.objectContaining({
      version: res.body.starterPolicy.version,
      defaults: res.body.starterPolicy.defaults,
      promptAppend: res.body.starterPolicy.promptAppend,
      paths: res.body.starterPolicy.paths,
    }));
    expect(res.body.contentParseError).toBeNull();
    expect(res.body.linterStatus).toEqual(expect.objectContaining({
      eslint: expect.objectContaining({
        policyDefaultEligible: false,
      }),
      tsc: expect.objectContaining({
        policyDefaultEligible: false,
      }),
    }));
  });

  it('warns when persisting generated review policy defaults fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    updateProjectGeneratedReviewPolicy.mockRejectedValueOnce(new Error('sqlite locked'));

    const { req, res } = createReqRes({ params: { id: 'proj-1' } });

    await callRouteHandler(reviewPolicyRouter, 'get', '/proj-1/review-policy', req, res);

    expect(res.statusCode).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      '[ReviewPolicy] Failed to persist generated project policy for proj-1:',
      'sqlite locked'
    );

    warnSpy.mockRestore();
  });

  it('returns generated project policy content when no repo policy file exists', async () => {
    const generatedPolicy = {
      version: 1,
      defaults: {
        requireEvidence: true,
        allowPraise: false,
        maxRecommendations: 8,
        largeReviewStructuralSkip: true,
        skipAllStructuralFiles: false,
      },
      promptAppend: ['Generated baseline guidance.'],
      linters: null,
      paths: [
        { glob: 'internal/**/*.go', fileClass: 'deep', promptAppend: '', mustCheckRules: [] },
      ],
    };
    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      name: 'Atlas Test Project',
      path: projectRoot,
      user_id: ANONYMOUS_USER_ID,
      generated_review_policy_json: JSON.stringify(generatedPolicy),
      generated_review_policy_hash: 'generated-hash',
      generated_review_policy_version: 1,
      generated_review_policy_generator_version: 'stack_aware_v1',
      generated_review_policy_generated_at: '2026-04-01T00:00:00.000Z',
    });

    const { req, res } = createReqRes({ params: { id: 'proj-1' } });

    await callRouteHandler(reviewPolicyRouter, 'get', '/proj-1/review-policy', req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.contentSource).toBe('generated');
    expect(JSON.parse(res.body.content)).toEqual(generatedPolicy);
    expect(res.body.exists).toBe(false);
  });

  it('removes the legacy default prompt guidance from generated policy previews', async () => {
    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      name: 'Atlas Test Project',
      path: projectRoot,
      user_id: ANONYMOUS_USER_ID,
      generated_review_policy_json: JSON.stringify({
        version: 1,
        defaults: {
          requireEvidence: true,
          allowPraise: false,
          maxRecommendations: 8,
        },
        promptAppend: [
          'Prioritize correctness, regressions, security, data loss, and missing tests. Avoid style-only feedback unless it materially affects maintainability.',
        ],
        paths: [],
      }),
      generated_review_policy_hash: 'generated-hash',
      generated_review_policy_version: 1,
      generated_review_policy_generator_version: 'stack_aware_v1',
      generated_review_policy_generated_at: '2026-04-01T00:00:00.000Z',
    });

    const { req, res } = createReqRes({ params: { id: 'proj-1' } });

    await callRouteHandler(reviewPolicyRouter, 'get', '/proj-1/review-policy', req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.contentSource).toBe('generated');
    expect(JSON.parse(res.body.content).promptAppend).toEqual([]);
    expect(res.body.normalizedPolicy?.promptAppend).toEqual([]);
  });

  it('normalizes and writes the review policy file and updates legacy atlas ignore rules', async () => {
    await fs.writeFile(path.join(projectRoot, '.gitignore'), '.atlas/\n', 'utf8');
    const { req, res } = createReqRes({
      params: { id: 'proj-1' },
      body: {
        content: JSON.stringify({
          version: 1,
          defaults: { requireEvidence: false },
          promptAppend: ['Custom prompt guidance.'],
          ignoredUnknownField: true,
        }, null, 2),
      },
    });

    await callRouteHandler(reviewPolicyRouter, 'put', '/proj-1/review-policy', req, res);

    const savedContent = await fs.readFile(path.join(projectRoot, '.atlas', 'review-policy.json'), 'utf8');
    const gitignoreContent = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(savedContent)).toEqual({
      version: 1,
      defaults: {
        requireEvidence: false,
        allowPraise: false,
        maxRecommendations: null,
        largeReviewStructuralSkip: true,
        skipAllStructuralFiles: false,
      },
      promptAppend: ['Custom prompt guidance.'],
      paths: [],
      linters: null,
    });
    expect(res.body.contentSource).toBe('saved');
    expect(res.body.normalizedPolicy).toEqual(JSON.parse(savedContent));
    expect(res.body.contentParseError).toBeNull();
    expect(gitignoreContent).toContain('.atlas/*');
    expect(gitignoreContent).toContain('!.atlas/review-policy.json');
    expect(gitignoreContent).not.toContain('\n.atlas/\n');
  });

  it('writes the review policy file without creating a new gitignore', async () => {
    const { req, res } = createReqRes({
      params: { id: 'proj-1' },
      body: {
        content: JSON.stringify({
          version: 1,
          defaults: { requireEvidence: true },
          promptAppend: [],
        }, null, 2),
      },
    });

    await callRouteHandler(reviewPolicyRouter, 'put', '/proj-1/review-policy', req, res);

    expect(res.statusCode).toBe(200);
    await expect(fs.access(path.join(projectRoot, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(projectRoot, '.atlas', 'review-policy.json'))).resolves.toBeUndefined();
  });

  it('resets the review policy file to the default content', async () => {
    await fs.mkdir(path.join(projectRoot, '.atlas'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.atlas', 'review-policy.json'),
      '{"version":1,"prompt":{"reviewAppend":"custom"}}\n',
      'utf8'
    );

    const { req, res } = createReqRes({
      params: { id: 'proj-1' },
    });

    await callRouteHandler(reviewPolicyRouter, 'post', '/proj-1/review-policy/reset', req, res);

    const savedContent = await fs.readFile(path.join(projectRoot, '.atlas', 'review-policy.json'), 'utf8');
    const parsed = JSON.parse(savedContent);

    expect(res.statusCode).toBe(200);
    expect(res.body.contentSource).toBe('saved');
    expect(parsed.defaults).toEqual({
      requireEvidence: true,
      allowPraise: false,
      maxRecommendations: 20,
      largeReviewStructuralSkip: true,
      skipAllStructuralFiles: false,
    });
    expect(parsed.promptAppend).toEqual([]);
    expect(parsed.paths).toEqual([]);
    expect(parsed.linters).toBeNull();
  });

  it('resets the review policy file to the generated baseline when present', async () => {
    const generatedPolicy = {
      version: 1,
      defaults: {
        requireEvidence: true,
        allowPraise: false,
        maxRecommendations: 8,
        largeReviewStructuralSkip: true,
        skipAllStructuralFiles: false,
      },
      promptAppend: ['Generated baseline guidance.'],
      linters: null,
      paths: [
        { glob: 'proto/**/*.proto', fileClass: 'structural', promptAppend: '', mustCheckRules: [] },
      ],
    };
    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      name: 'Atlas Test Project',
      path: projectRoot,
      user_id: ANONYMOUS_USER_ID,
      generated_review_policy_json: JSON.stringify(generatedPolicy),
      generated_review_policy_hash: 'generated-hash',
      generated_review_policy_version: 1,
      generated_review_policy_generator_version: 'stack_aware_v1',
      generated_review_policy_generated_at: '2026-04-01T00:00:00.000Z',
    });

    const { req, res } = createReqRes({ params: { id: 'proj-1' } });

    await callRouteHandler(reviewPolicyRouter, 'post', '/proj-1/review-policy/reset', req, res);

    const savedContent = await fs.readFile(path.join(projectRoot, '.atlas', 'review-policy.json'), 'utf8');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(savedContent)).toEqual(generatedPolicy);
  });

  it('includes repo-stable smart linter defaults when resetting a configured project', async () => {
    await fs.writeFile(path.join(projectRoot, 'eslint.config.js'), 'export default [];\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'tsconfig.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, '.semgrep.yml'), 'rules: []\n', 'utf8');

    const { req, res } = createReqRes({
      params: { id: 'proj-1' },
    });

    await callRouteHandler(reviewPolicyRouter, 'post', '/proj-1/review-policy/reset', req, res);

    const parsed = JSON.parse(await fs.readFile(path.join(projectRoot, '.atlas', 'review-policy.json'), 'utf8'));

    expect(res.statusCode).toBe(200);
    expect(parsed.linters).toEqual({
      enabled: true,
      mode: 'fallback_if_missing',
      eslint: { enabled: true },
      tsc: { enabled: true },
      dotnet: { enabled: false },
      dotnetFormat: { enabled: false },
      semgrep: { enabled: true, allowAtlasManagedFallback: true },
    });
    expect(res.body.linterStatus).toEqual(expect.objectContaining({
      eslint: expect.objectContaining({
        policyDefaultEligible: true,
        hasConfig: true,
      }),
      tsc: expect.objectContaining({
        policyDefaultEligible: true,
        hasConfig: true,
      }),
      semgrep: expect.objectContaining({
        policyDefaultEligible: true,
        hasConfig: true,
      }),
    }));
  });

  it('surfaces Atlas-managed Semgrep fallback in starter policy status for supported repos', async () => {
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'src', 'app.ts'), 'export const ok = true;\n', 'utf8');

    const { req, res } = createReqRes({ params: { id: 'proj-1' } });

    await callRouteHandler(reviewPolicyRouter, 'get', '/proj-1/review-policy', req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.starterPolicy?.linters).toEqual(expect.objectContaining({
      enabled: true,
      mode: 'fallback_if_missing',
      semgrep: expect.objectContaining({
        enabled: true,
        allowAtlasManagedFallback: true,
      }),
    }));
    expect(res.body.linterStatus?.semgrep).toEqual(expect.objectContaining({
      policyDefaultEligible: false,
      atlasManagedEligible: true,
    }));
  });
});

function createReqRes(overrides = {}) {
  const req = {
    params: {},
    body: {},
    query: {},
    user: null,
    ...overrides,
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return { req, res };
}

async function callRouteHandler(router, method, pathName, req, res) {
  const layer = router.stack.find((entry) => entry.route?.path && entry.route.methods?.[method] && matchExpressPath(entry.route.path, pathName));
  if (!layer) {
    throw new Error(`Route not found for ${method.toUpperCase()} ${pathName}`);
  }
  req.params = extractParams(layer.route.path, pathName);
  await layer.route.stack[0].handle(req, res, () => {});
  if (layer.route.stack[1]) {
    await layer.route.stack[1].handle(req, res);
  }
}

function matchExpressPath(routePath, actualPath) {
  const pattern = new RegExp(`^${routePath.replace(/:[^/]+/g, '[^/]+')}$`);
  return pattern.test(actualPath);
}

function extractParams(routePath, actualPath) {
  const routeParts = routePath.split('/');
  const actualParts = actualPath.split('/');
  const params = {};
  routeParts.forEach((part, index) => {
    if (part.startsWith(':')) {
      params[part.slice(1)] = actualParts[index];
    }
  });
  return params;
}
