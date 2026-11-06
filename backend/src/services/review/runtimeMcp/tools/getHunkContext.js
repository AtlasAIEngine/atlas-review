import { resolveSafeProjectPath, relativeToProjectRoot } from '../pathSafety.js';
import { runGit, isValidSha } from '../gitOps.js';

const DEFAULT_CONTEXT_LINES = 20;
const MAX_CONTEXT_LINES = 100;

export const getHunkContextSchema = {
  name: 'get_hunk_context',
  description: 'Return a window of `contextLines` lines on each side of a target line in the head version of a file. Use this when you need surrounding code for a specific line, e.g., to verify a finding or inspect callers. Default 20 lines each side; max 100 each side. Output is line-numbered.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Project-relative path. Absolute or escaping paths are rejected.',
      },
      line: {
        type: 'integer',
        minimum: 1,
        description: '1-indexed line in the head version of the file.',
      },
      contextLines: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Lines of context on each side of `line`. Defaults to 20. Hard cap 100.',
      },
    },
    required: ['path', 'line'],
    additionalProperties: false,
  },
};

export function createGetHunkContextHandler({ projectRoot, headSha }) {
  if (!isValidSha(headSha)) {
    throw new Error('headSha must be a valid hex SHA');
  }
  return async function handle({ path: userPath, line, contextLines }) {
    if (!Number.isInteger(line) || line < 1) {
      throw new Error('line must be a positive integer');
    }
    const ctx = (contextLines === undefined || contextLines === null)
      ? DEFAULT_CONTEXT_LINES
      : contextLines;
    if (!Number.isInteger(ctx) || ctx < 1 || ctx > MAX_CONTEXT_LINES) {
      throw new Error(`contextLines must be an integer in [1, ${MAX_CONTEXT_LINES}]`);
    }
    const abs = resolveSafeProjectPath(projectRoot, userPath);
    const rel = relativeToProjectRoot(projectRoot, abs);
    const { stdout } = await runGit(projectRoot, ['show', `${headSha}:${rel}`]);
    const lines = stdout.split('\n');
    const total = lines.length;
    if (line > total) {
      return {
        content: [
          {
            type: 'text',
            text: `(file ${rel} at ${headSha} has only ${total} lines; requested line ${line} is past EOF)`,
          },
        ],
      };
    }
    const startLine = Math.max(1, line - ctx);
    const endLine = Math.min(total, line + ctx);
    const slice = lines.slice(startLine - 1, endLine);
    const numbered = slice.map((content, idx) => {
      const lineNo = startLine + idx;
      const marker = lineNo === line ? '>>' : '  ';
      return `${marker}${lineNo}\t${content}`;
    }).join('\n');
    return {
      content: [
        { type: 'text', text: `${rel} @ ${headSha}, lines ${startLine}-${endLine} (anchor: ${line})\n\n${numbered}` },
      ],
    };
  };
}
