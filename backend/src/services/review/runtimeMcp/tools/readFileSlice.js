import { resolveSafeProjectPath, relativeToProjectRoot } from '../pathSafety.js';
import { runGit, isValidSha } from '../gitOps.js';

const MAX_SLICE_LINES = 500;

export const readFileSliceSchema = {
  name: 'read_file_slice',
  description: 'Return lines [startLine..endLine] (1-indexed, inclusive) of a file at the head SHA of the review. Range capped at 500 lines. Output is line-numbered. Prefer this over reading entire files when you only need to inspect a specific span.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project-relative path. Absolute or escaping paths are rejected.',
      },
      startLine: {
        type: 'integer',
        minimum: 1,
        description: '1-indexed inclusive start line.',
      },
      endLine: {
        type: 'integer',
        minimum: 1,
        description: '1-indexed inclusive end line. Must be >= startLine and (endLine - startLine + 1) <= 500.',
      },
    },
    required: ['path', 'startLine', 'endLine'],
    additionalProperties: false,
  },
};

export function createReadFileSliceHandler({ projectRoot, headSha }) {
  if (!isValidSha(headSha)) {
    throw new Error('headSha must be a valid hex SHA');
  }
  return async function handle({ path: userPath, startLine, endLine }) {
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error('startLine must be a positive integer');
    }
    if (!Number.isInteger(endLine) || endLine < startLine) {
      throw new Error('endLine must be an integer >= startLine');
    }
    const span = endLine - startLine + 1;
    if (span > MAX_SLICE_LINES) {
      throw new Error(`requested span ${span} lines exceeds cap ${MAX_SLICE_LINES}`);
    }
    const abs = resolveSafeProjectPath(projectRoot, userPath);
    const rel = relativeToProjectRoot(projectRoot, abs);
    const { stdout } = await runGit(projectRoot, [
      'show',
      `${headSha}:${rel}`,
    ]);
    const lines = stdout.split('\n');
    if (startLine > lines.length) {
      return {
        content: [
          {
            type: 'text',
            text: `(file ${rel} at ${headSha} has only ${lines.length} lines; startLine ${startLine} is past EOF)`,
          },
        ],
      };
    }
    const clampedEnd = Math.min(endLine, lines.length);
    const slice = lines.slice(startLine - 1, clampedEnd);
    const numbered = slice.map((line, idx) => `${startLine + idx}\t${line}`).join('\n');
    const truncationNote = clampedEnd < endLine
      ? `\n\n[note: clamped to EOF at line ${clampedEnd} (file has ${lines.length} lines total)]`
      : '';
    return {
      content: [
        { type: 'text', text: numbered + truncationNote },
      ],
    };
  };
}
