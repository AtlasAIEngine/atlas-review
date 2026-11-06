import { resolveSafeProjectPath, relativeToProjectRoot } from '../pathSafety.js';
import { runGit, isValidSha } from '../gitOps.js';

const MAX_DIFF_BYTES = 64 * 1024;

export const getDiffForFileSchema = {
  name: 'get_diff_for_file',
  description: 'Return the unified diff for a single file across the review range (mergeBase..head). Use this instead of running git diff via Bash — the SHAs and pathspec are already scoped to the review. Result is capped at 64KB.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project-relative path to the file. Absolute paths are rejected. Paths that escape the project root are rejected.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

export function createGetDiffForFileHandler({ projectRoot, mergeBaseSha, headSha }) {
  if (!isValidSha(mergeBaseSha)) {
    throw new Error('mergeBaseSha must be a valid hex SHA');
  }
  if (!isValidSha(headSha)) {
    throw new Error('headSha must be a valid hex SHA');
  }
  return async function handle({ path: userPath }) {
    const abs = resolveSafeProjectPath(projectRoot, userPath);
    const rel = relativeToProjectRoot(projectRoot, abs);
    const { stdout, truncated } = await runGit(projectRoot, [
      'diff',
      `${mergeBaseSha}..${headSha}`,
      '--',
      rel,
    ]);
    const limited = stdout.length > MAX_DIFF_BYTES
      ? `${stdout.slice(0, MAX_DIFF_BYTES)}\n[... diff truncated at ${MAX_DIFF_BYTES} bytes; ${stdout.length - MAX_DIFF_BYTES} bytes omitted ...]`
      : stdout;
    if (limited.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `(no diff for ${rel} in ${mergeBaseSha}..${headSha} — file unchanged or path outside changeset)`,
          },
        ],
      };
    }
    const note = truncated || stdout.length > MAX_DIFF_BYTES
      ? '\n\n[note: output was truncated; ask for a hunk window via get_hunk_context if you need a specific section]'
      : '';
    return {
      content: [
        { type: 'text', text: limited + note },
      ],
    };
  };
}
