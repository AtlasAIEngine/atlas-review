import { describe, expect, it } from 'vitest';

import {
  classifyToolOperation,
  extractToolPathFromToolInput,
  isFileMutationTool,
  isSnapshotEligibleFileMutationTool,
} from '../../../../shared/toolOperationClassifier.js';

describe('toolOperationClassifier', () => {
  it('normalizes write-file aliases into snapshot-eligible file mutations', () => {
    const writeFile = classifyToolOperation('write_file', { file_path: 'src/App.tsx' });
    const fileWrite = classifyToolOperation('file_write', { path: 'src/main.tsx' });
    const createFile = classifyToolOperation('create_file', { target_file: 'index.html' });

    expect(writeFile.fileAction).toBe('write');
    expect(writeFile.filePath).toBe('src/App.tsx');
    expect(writeFile.snapshotEligible).toBe(true);

    expect(fileWrite.fileAction).toBe('write');
    expect(fileWrite.filePath).toBe('src/main.tsx');
    expect(fileWrite.snapshotEligible).toBe(true);

    expect(createFile.fileAction).toBe('create');
    expect(createFile.filePath).toBe('index.html');
    expect(createFile.snapshotEligible).toBe(true);
  });

  it('treats file-change events according to their declared action', () => {
    expect(isFileMutationTool('FileChange', { path: 'src/App.tsx', action: 'edit' })).toBe(true);
    expect(isSnapshotEligibleFileMutationTool('FileChange', { path: 'src/App.tsx', action: 'edit' })).toBe(true);

    const readOnly = classifyToolOperation('file_change', { path: 'src/App.tsx', action: 'read' });
    expect(readOnly.kind).toBe('read');
    expect(readOnly.mutatesFiles).toBe(false);
    expect(readOnly.snapshotEligible).toBe(false);
  });

  it('treats file-change events with no declared action as non-mutating', () => {
    const unknown = classifyToolOperation('file_change', { path: 'src/App.tsx' });

    expect(unknown.kind).toBe('unknown');
    expect(unknown.fileAction).toBe('');
    expect(unknown.mutatesFiles).toBe(false);
    expect(unknown.snapshotEligible).toBe(false);
  });

  it('extracts the first relevant path from nested tool input payloads', () => {
    expect(
      extractToolPathFromToolInput({
        arguments: {
          destination_path: 'src/components/Hero.tsx',
        },
      }),
    ).toBe('src/components/Hero.tsx');
  });

  it('recognizes camelCase-collapsed file path keys', () => {
    expect(extractToolPathFromToolInput({ targetFile: 'index.html' })).toBe('index.html');
    expect(extractToolPathFromToolInput({ outputFile: 'dist/app.js' })).toBe('dist/app.js');
    expect(extractToolPathFromToolInput({ sourceFile: 'src/main.tsx' })).toBe('src/main.tsx');
  });
});
