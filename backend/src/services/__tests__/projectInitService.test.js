import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import projectInitService from '../projectInitService.js';

describe('projectInitService', () => {
  let projectDir;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-project-init-'));
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('migrates legacy .atlas ignore rules to allow the review policy file', async () => {
    await fs.writeFile(
      path.join(projectDir, '.gitignore'),
      ['node_modules/', '.atlas/', 'dist/', ''].join('\n'),
      'utf8'
    );

    const status = await projectInitService.ensureAtlasIgnored(projectDir);
    const content = await fs.readFile(path.join(projectDir, '.gitignore'), 'utf8');

    expect(status).toBe('updated');
    expect(content).not.toContain('\n.atlas/\n');
    expect(content).toContain('.atlas/*');
    expect(content).toContain('!.atlas/review-policy.json');
  });

  it('creates a default review policy file without overwriting an existing one', async () => {
    const firstStatus = await projectInitService.ensureDefaultReviewPolicy(projectDir);
    const reviewPolicyPath = path.join(projectDir, '.atlas', 'review-policy.json');
    const firstContent = await fs.readFile(reviewPolicyPath, 'utf8');

    expect(firstStatus).toBe('created');
    expect(JSON.parse(firstContent)).toMatchObject({
      version: 1,
      defaults: {
        requireEvidence: true,
        allowPraise: false,
        maxRecommendations: 20,
      },
      paths: expect.any(Array),
    });

    await fs.writeFile(reviewPolicyPath, '{"version":1,"prompt":{"reviewAppend":"custom"}}\n', 'utf8');

    const secondStatus = await projectInitService.ensureDefaultReviewPolicy(projectDir);
    const secondContent = await fs.readFile(reviewPolicyPath, 'utf8');

    expect(secondStatus).toBe('already_present');
    expect(secondContent).toBe('{"version":1,"prompt":{"reviewAppend":"custom"}}\n');
  });

  it('initializes the project repo without writing Atlas metadata', async () => {
    const result = await projectInitService.initializeProject(projectDir);

    expect(result.gitignore).toBe(false);
    expect(result.atlasDir).toBe(false);
    await expect(fs.access(path.join(projectDir, '.gitignore'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(path.join(projectDir, '.atlas'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(path.join(projectDir, '.atlas', 'review-policy.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
