/**
 * ChangeSet Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import changesetService from '../changesetService.js';
import { getProjectStoragePath } from '../atlasProjectStorageService.js';

describe('changesetService', () => {
  let testProjectPath;
  let testDataDir;
  const originalDataDir = process.env.ATLAS_DATA_DIR;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testProjectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-changeset-test-'));
    testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-appdata-test-'));
    process.env.ATLAS_DATA_DIR = testDataDir;
  });

  afterEach(async () => {
    // Clean up the temp directory
    try {
      await fs.rm(testProjectPath, { recursive: true, force: true });
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    if (originalDataDir) {
      process.env.ATLAS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.ATLAS_DATA_DIR;
    }
  });

  describe('createChangeSet', () => {
    it('should create a changeset with correct structure', async () => {
      const files = [
        { path: 'src/app.js', before: null, after: 'console.log("hello");' },
      ];

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        title: 'Added app.js',
        source: 'agent',
        files,
      });

      expect(changeset.id).toBeDefined();
      expect(changeset.title).toBe('Added app.js');
      expect(changeset.source).toBe('agent');
      expect(changeset.status).toBe('applied');
      expect(changeset.createdAt).toBeDefined();
      expect(changeset.files).toHaveLength(1);
      expect(changeset.files[0].path).toBe('src/app.js');
      expect(changeset.files[0].before).toBeNull();
      expect(changeset.files[0].after).toBe('console.log("hello");');
      expect(changeset.files[0].language).toBe('javascript');
    });

    it('should auto-generate title for new file', async () => {
      const files = [
        { path: 'src/utils.ts', before: null, after: 'export const foo = 1;' },
      ];

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files,
      });

      expect(changeset.title).toBe('Created utils.ts');
    });

    it('should auto-generate title for modified file', async () => {
      const files = [
        { path: 'src/config.json', before: '{}', after: '{"key": "value"}' },
      ];

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files,
      });

      expect(changeset.title).toBe('Modified config.json');
    });

    it('should auto-generate title for multiple files', async () => {
      const files = [
        { path: 'src/a.js', before: 'a', after: 'a-modified' },
        { path: 'src/b.js', before: 'b', after: 'b-modified' },
        { path: 'src/c.js', before: 'c', after: 'c-modified' },
      ];

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files,
      });

      expect(changeset.title).toBe('Modified 3 files (a.js +2 more)');
    });

    it('should create changesets.json index file', async () => {
      const files = [
        { path: 'test.txt', before: null, after: 'content' },
      ];

      await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files,
      });

      const indexPath = getProjectStoragePath(testProjectPath, 'changesets.json');
      const indexContent = await fs.readFile(indexPath, 'utf8');
      const index = JSON.parse(indexContent);

      expect(index.version).toBe(1);
      expect(index.changesets).toHaveLength(1);
      expect(index.changesets[0].fileCount).toBe(1);
      expect(index.changesets[0].filePaths).toEqual(['test.txt']);
    });

    it('should reject empty files array', async () => {
      await expect(
        changesetService.createChangeSet(testProjectPath, {
          source: 'agent',
          files: [],
        })
      ).rejects.toThrow('At least one file change is required');
    });

    it('should reject invalid source', async () => {
      await expect(
        changesetService.createChangeSet(testProjectPath, {
          source: 'invalid',
          files: [{ path: 'test.txt', before: null, after: 'content' }],
        })
      ).rejects.toThrow('Source must be one of: agent, visual_edit, workflow');
    });

    it('stores runtime metadata outside the repo', async () => {
      await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      await expect(fs.access(path.join(testProjectPath, '.atlas'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.access(getProjectStoragePath(testProjectPath, 'changesets.json'))).resolves.toBeUndefined();
    });
  });

  describe('getChangeSets', () => {
    it('should return empty array when no changesets exist', async () => {
      const changesets = await changesetService.getChangeSets(testProjectPath);
      expect(changesets).toEqual([]);
    });

    it('should return all changesets in index (newest first)', async () => {
      await changesetService.createChangeSet(testProjectPath, {
        title: 'First',
        source: 'agent',
        files: [{ path: 'a.js', before: null, after: 'a' }],
      });

      await changesetService.createChangeSet(testProjectPath, {
        title: 'Second',
        source: 'visual_edit',
        files: [{ path: 'b.js', before: null, after: 'b' }],
      });

      const changesets = await changesetService.getChangeSets(testProjectPath);

      expect(changesets).toHaveLength(2);
      expect(changesets[0].title).toBe('Second');
      expect(changesets[1].title).toBe('First');
    });

    it('should not include file contents in index', async () => {
      await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.js', before: 'before', after: 'after' }],
      });

      const changesets = await changesetService.getChangeSets(testProjectPath);

      expect(changesets[0].files).toBeUndefined();
      expect(changesets[0].fileCount).toBe(1);
      expect(changesets[0].filePaths).toEqual(['test.js']);
    });
  });

  describe('getChangeSet', () => {
    it('should return null for non-existent changeset', async () => {
      const changeset = await changesetService.getChangeSet(testProjectPath, 'non-existent-id');
      expect(changeset).toBeNull();
    });

    it('migrates legacy repo-local changesets into app data on read', async () => {
      const legacyAtlasDir = path.join(testProjectPath, '.atlas', 'changesets');
      await fs.mkdir(legacyAtlasDir, { recursive: true });
      await fs.writeFile(
        path.join(testProjectPath, '.atlas', 'changesets.json'),
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          changesets: [{ id: 'legacy-cs', title: 'Legacy', source: 'agent', fileCount: 1, filePaths: ['a.js'] }],
        }, null, 2),
        'utf8'
      );
      await fs.writeFile(
        path.join(legacyAtlasDir, 'legacy-cs.json'),
        JSON.stringify({
          id: 'legacy-cs',
          title: 'Legacy',
          source: 'agent',
          status: 'applied',
          createdAt: new Date().toISOString(),
          files: [{ path: 'a.js', before: null, after: 'console.log(1);', language: 'javascript' }],
          verification: null,
        }, null, 2),
        'utf8'
      );

      const changesets = await changesetService.getChangeSets(testProjectPath);
      const changeset = await changesetService.getChangeSet(testProjectPath, 'legacy-cs');

      expect(changesets).toHaveLength(1);
      expect(changeset?.id).toBe('legacy-cs');
      await expect(fs.access(getProjectStoragePath(testProjectPath, 'changesets.json'))).resolves.toBeUndefined();
      await expect(fs.access(getProjectStoragePath(testProjectPath, 'changesets', 'legacy-cs.json'))).resolves.toBeUndefined();
    });

    it('should return full changeset with file contents', async () => {
      const created = await changesetService.createChangeSet(testProjectPath, {
        title: 'Test',
        source: 'agent',
        files: [{ path: 'test.js', before: 'old', after: 'new' }],
      });

      const changeset = await changesetService.getChangeSet(testProjectPath, created.id);

      expect(changeset.id).toBe(created.id);
      expect(changeset.title).toBe('Test');
      expect(changeset.files).toHaveLength(1);
      expect(changeset.files[0].before).toBe('old');
      expect(changeset.files[0].after).toBe('new');
    });

    it('should avoid transient JSON parse errors during concurrent read/write updates', async () => {
      const created = await changesetService.createChangeSet(testProjectPath, {
        title: 'Concurrent updates',
        source: 'agent',
        files: [{ path: 'src/big.json', before: null, after: 'x'.repeat(250000) }],
      });

      const parseErrorMessages = [];
      let writerDone = false;

      const writer = (async () => {
        for (let i = 0; i < 60; i += 1) {
          await changesetService.updateChangeSetVerification(
            testProjectPath,
            created.id,
            'lint',
            i % 2 === 0 ? 'pass' : 'fail',
            `run-${i}\n${'y'.repeat(300000)}`
          );
          await changesetService.updateChangeSetStatus(
            testProjectPath,
            created.id,
            i % 3 === 0 ? 'applied' : 'verified'
          );
        }
        writerDone = true;
      })();

      const readers = Array.from({ length: 8 }, () => (async () => {
        while (!writerDone) {
          try {
            await changesetService.getChangeSet(testProjectPath, created.id);
          } catch (error) {
            const message = String(error?.message || error);
            if (/Unexpected end of JSON input|Unterminated string in JSON/i.test(message)) {
              parseErrorMessages.push(message);
            }
          }
        }
      })());

      await Promise.all([writer, ...readers]);
      expect(parseErrorMessages).toEqual([]);
    }, 15000);
  });

  describe('updateChangeSetReviewIndex', () => {
    it('migrates a legacy repo-local index before writing review fields', async () => {
      const legacyAtlasDir = path.join(testProjectPath, '.atlas', 'changesets');
      await fs.mkdir(legacyAtlasDir, { recursive: true });
      await fs.writeFile(
        path.join(testProjectPath, '.atlas', 'changesets.json'),
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          changesets: [{ id: 'legacy-cs', title: 'Legacy', source: 'agent', reviewStatus: 'none' }],
        }, null, 2),
        'utf8'
      );

      const updated = await changesetService.updateChangeSetReviewIndex(testProjectPath, 'legacy-cs', {
        reviewStatus: 'completed',
        reviewRiskLevel: 'medium',
        reviewSummary: 'Legacy review migrated',
      });

      expect(updated).toBe(true);

      const appDataIndexPath = getProjectStoragePath(testProjectPath, 'changesets.json');
      const indexContent = JSON.parse(await fs.readFile(appDataIndexPath, 'utf8'));
      expect(indexContent.changesets).toHaveLength(1);
      expect(indexContent.changesets[0].reviewStatus).toBe('completed');
      expect(indexContent.changesets[0].reviewRiskLevel).toBe('medium');
      expect(indexContent.changesets[0].reviewSummary).toBe('Legacy review migrated');
    });
  });

  describe('revertChangeSet', () => {
    it('should restore file to before content', async () => {
      // Create the actual file with "after" content
      const filePath = path.join(testProjectPath, 'test.txt');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'after content', 'utf8');

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: 'before content', after: 'after content' }],
      });

      const result = await changesetService.revertChangeSet(testProjectPath, changeset.id);

      expect(result.success).toBe(true);
      expect(result.revertedFiles).toHaveLength(1);
      expect(result.revertedFiles[0].action).toBe('reverted');

      // Verify file content was restored
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toBe('before content');
    });

    it('should delete file that was created', async () => {
      // Create the actual file
      const filePath = path.join(testProjectPath, 'new-file.txt');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'new content', 'utf8');

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'new-file.txt', before: null, after: 'new content' }],
      });

      const result = await changesetService.revertChangeSet(testProjectPath, changeset.id);

      expect(result.success).toBe(true);
      expect(result.revertedFiles[0].action).toBe('deleted');

      // Verify file was deleted
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('should recreate file that was deleted', async () => {
      const filePath = path.join(testProjectPath, 'deleted-file.txt');
      // File doesn't exist (simulating deletion)

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'deleted-file.txt', before: 'original content', after: null }],
      });

      const result = await changesetService.revertChangeSet(testProjectPath, changeset.id);

      expect(result.success).toBe(true);
      expect(result.revertedFiles[0].action).toBe('restored');

      // Verify file was recreated
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toBe('original content');
    });

    it('should update changeset status to reverted', async () => {
      const filePath = path.join(testProjectPath, 'test.txt');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'after', 'utf8');

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: 'before', after: 'after' }],
      });

      await changesetService.revertChangeSet(testProjectPath, changeset.id);

      const updated = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(updated.status).toBe('reverted');
    });

    it('should throw error for non-existent changeset', async () => {
      await expect(
        changesetService.revertChangeSet(testProjectPath, 'non-existent')
      ).rejects.toThrow('Changeset not found');
    });

    it('should throw error for already reverted changeset', async () => {
      const filePath = path.join(testProjectPath, 'test.txt');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'after', 'utf8');

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: 'before', after: 'after' }],
      });

      await changesetService.revertChangeSet(testProjectPath, changeset.id);

      await expect(
        changesetService.revertChangeSet(testProjectPath, changeset.id)
      ).rejects.toThrow('Changeset is already reverted');
    });
  });

  describe('reapplyChangeSet', () => {
    it('should restore file to after content', async () => {
      // Create the actual file with "after" content first
      const filePath = path.join(testProjectPath, 'test.txt');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'after content', 'utf8');

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: 'before content', after: 'after content' }],
      });

      // Revert the changeset first
      await changesetService.revertChangeSet(testProjectPath, changeset.id);

      // Verify file content was reverted
      let content = await fs.readFile(filePath, 'utf8');
      expect(content).toBe('before content');

      // Now reapply the changeset
      const result = await changesetService.reapplyChangeSet(testProjectPath, changeset.id);

      expect(result.success).toBe(true);
      expect(result.reappliedFiles).toHaveLength(1);
      expect(result.reappliedFiles[0].action).toBe('reapplied');

      // Verify file content was restored to "after"
      content = await fs.readFile(filePath, 'utf8');
      expect(content).toBe('after content');
    });

    it('should recreate file that was created in original changeset', async () => {
      // Create the actual file
      const filePath = path.join(testProjectPath, 'new-file.txt');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'new content', 'utf8');

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'new-file.txt', before: null, after: 'new content' }],
      });

      // Revert (deletes the file)
      await changesetService.revertChangeSet(testProjectPath, changeset.id);
      await expect(fs.access(filePath)).rejects.toThrow();

      // Reapply (recreates the file)
      const result = await changesetService.reapplyChangeSet(testProjectPath, changeset.id);

      expect(result.success).toBe(true);
      expect(result.reappliedFiles[0].action).toBe('created');

      // Verify file was recreated
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toBe('new content');
    });

    it('should delete file that was deleted in original changeset', async () => {
      const filePath = path.join(testProjectPath, 'deleted-file.txt');

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'deleted-file.txt', before: 'original content', after: null }],
      });

      // Revert (restores the file)
      await changesetService.revertChangeSet(testProjectPath, changeset.id);
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).toBe('original content');

      // Reapply (deletes the file again)
      const result = await changesetService.reapplyChangeSet(testProjectPath, changeset.id);

      expect(result.success).toBe(true);
      expect(result.reappliedFiles[0].action).toBe('deleted');

      // Verify file was deleted
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('should update changeset status to applied', async () => {
      const filePath = path.join(testProjectPath, 'test.txt');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'after', 'utf8');

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: 'before', after: 'after' }],
      });

      await changesetService.revertChangeSet(testProjectPath, changeset.id);

      let updated = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(updated.status).toBe('reverted');

      await changesetService.reapplyChangeSet(testProjectPath, changeset.id);

      updated = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(updated.status).toBe('applied');
    });

    it('should throw error for non-existent changeset', async () => {
      await expect(
        changesetService.reapplyChangeSet(testProjectPath, 'non-existent')
      ).rejects.toThrow('Changeset not found');
    });

    it('should throw error for changeset that is not reverted', async () => {
      const filePath = path.join(testProjectPath, 'test.txt');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'after', 'utf8');

      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: 'before', after: 'after' }],
      });

      // Try to reapply without reverting first
      await expect(
        changesetService.reapplyChangeSet(testProjectPath, changeset.id)
      ).rejects.toThrow('Only reverted changesets can be reapplied');
    });
  });

  describe('updateChangeSetStatus', () => {
    it('should update status in both index and full changeset', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      await changesetService.updateChangeSetStatus(testProjectPath, changeset.id, 'reverted');

      const updated = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(updated.status).toBe('reverted');

      const index = await changesetService.getChangeSets(testProjectPath);
      expect(index[0].status).toBe('reverted');
    });

    it('should reject invalid status', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      await expect(
        changesetService.updateChangeSetStatus(testProjectPath, changeset.id, 'invalid')
      ).rejects.toThrow('Status must be one of: applied, verified, committed, published, reverted');
    });

    it('should accept committed status', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      await changesetService.updateChangeSetStatus(testProjectPath, changeset.id, 'committed');

      const updated = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(updated.status).toBe('committed');
    });
  });

  describe('createChangeSet verification', () => {
    it('should initialize verification object with all not_run', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      expect(changeset.verification).toBeDefined();
      expect(changeset.verification.lint).toBe('not_run');
      expect(changeset.verification.unit).toBe('not_run');
      expect(changeset.verification.e2e).toBe('not_run');
      expect(changeset.verification.lastRunAt).toBeNull();
      expect(changeset.verification.logs).toEqual({});
    });
  });

  describe('updateChangeSetVerification', () => {
    it('should update lint verification status', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      const updated = await changesetService.updateChangeSetVerification(
        testProjectPath,
        changeset.id,
        'lint',
        'pass',
        'All lint checks passed'
      );

      expect(updated.verification.lint).toBe('pass');
      expect(updated.verification.lastRunAt).toBeDefined();
      expect(updated.verification.logs.lint).toBe('All lint checks passed');
    });

    it('should update unit verification status', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      const updated = await changesetService.updateChangeSetVerification(
        testProjectPath,
        changeset.id,
        'unit',
        'fail',
        '2 tests failed'
      );

      expect(updated.verification.unit).toBe('fail');
      expect(updated.verification.logs.unit).toBe('2 tests failed');
    });

    it('should store custom check results by check id', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      const updated = await changesetService.updateChangeSetVerification(
        testProjectPath,
        changeset.id,
        'typecheck',
        'pass',
        'Type check passed',
        {
          kind: 'typecheck',
          label: 'Type Check',
          command: 'npx tsc --noEmit',
          duration: 321,
          exitCode: 0,
        }
      );

      expect(updated.verification.typecheck).toBeUndefined();
      expect(updated.verification.logs.typecheck).toBe('Type check passed');
      expect(updated.verification.checks.typecheck).toEqual(expect.objectContaining({
        id: 'typecheck',
        kind: 'typecheck',
        label: 'Type Check',
        command: 'npx tsc --noEmit',
        status: 'pass',
        duration: 321,
        exitCode: 0,
      }));
    });

    it('should reject invalid result', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      await expect(
        changesetService.updateChangeSetVerification(testProjectPath, changeset.id, 'lint', 'invalid')
      ).rejects.toThrow('Result must be either "pass" or "fail"');
    });

    it('should truncate logs exceeding 50KB', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      // Create a log string larger than 50KB
      const largeLogs = 'x'.repeat(60 * 1024);

      const updated = await changesetService.updateChangeSetVerification(
        testProjectPath,
        changeset.id,
        'lint',
        'pass',
        largeLogs
      );

      expect(updated.verification.logs.lint.length).toBeLessThan(largeLogs.length);
      expect(updated.verification.logs.lint).toContain('... [truncated]');
    });

    it('should update index with verification summary', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      await changesetService.updateChangeSetVerification(
        testProjectPath,
        changeset.id,
        'lint',
        'pass'
      );

      const index = await changesetService.getChangeSets(testProjectPath);
      expect(index[0].verification).toBeDefined();
      expect(index[0].verification.lint).toBe('pass');
      // Index should not include logs to keep it lightweight
      expect(index[0].verification.logs).toBeUndefined();
    });
  });

  describe('deleteChangeSet', () => {
    it('should return false for non-existent changeset', async () => {
      const result = await changesetService.deleteChangeSet(testProjectPath, 'non-existent');
      expect(result).toBe(false);
    });

    it('should delete changeset file and remove from index', async () => {
      const changeset = await changesetService.createChangeSet(testProjectPath, {
        source: 'agent',
        files: [{ path: 'test.txt', before: null, after: 'content' }],
      });

      const result = await changesetService.deleteChangeSet(testProjectPath, changeset.id);
      expect(result).toBe(true);

      const retrieved = await changesetService.getChangeSet(testProjectPath, changeset.id);
      expect(retrieved).toBeNull();

      const index = await changesetService.getChangeSets(testProjectPath);
      expect(index).toHaveLength(0);
    });
  });
});
