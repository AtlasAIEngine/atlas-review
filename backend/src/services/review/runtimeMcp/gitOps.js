import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Hard upper bound on bytes returned by any git operation. Keeps a runaway
 * diff/blob from blowing the agent's context window. Tools may apply tighter
 * caps before calling here.
 */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Buffer ceiling we let `execFile` capture before it rejects. Has to be
 * comfortably larger than `MAX_OUTPUT_BYTES` so the post-await truncation
 * can run on oversized output instead of `execFile` rejecting with
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and turning a large diff into a
 * tool error. 16 MiB is generous for any review-time git output and still
 * caps memory pressure.
 */
export const EXEC_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Hard upper bound on git wall time. Slow git host, NFS, or huge repo
 * shouldn't hold the agent's tool call open indefinitely.
 */
export const GIT_TIMEOUT_MS = 30 * 1000;

/**
 * Validate a SHA-like ref (40-char hex, or short hex >= 4 chars).
 * Reject anything else to keep `git diff <range>` safe from injection.
 * Note: full pathnames or branch names are NOT accepted by this helper —
 * runtime MCP tools should only ever see resolved SHAs from the review.
 */
export function isValidSha(value) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{4,40}$/i.test(value);
}

/**
 * Decide whether an `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` from execFile means
 * "stdout overflowed and we should return truncated output" or "stderr
 * overflowed and the git command actually failed."
 *
 * `execFile` applies the same `maxBuffer` cap to both streams and surfaces
 * the same error code either way. Treating both cases as "truncated stdout"
 * lets a failing git command (huge stderr, empty stdout) reach the caller
 * as a successful-looking `{ stdout: '', truncated: true }`, hiding bad
 * arguments or repository-state errors from the review agent.
 *
 * Disambiguation order:
 *   1. Node's error message includes either "stdout maxBuffer" or
 *      "stderr maxBuffer" — that's the canonical signal.
 *   2. Some Node versions attach the partial output as `err.stdout` /
 *      `err.stderr`. If the message is missing, fall back to whichever
 *      side has bytes.
 *   3. If we still cannot tell, treat as failure (re-throw): false-error
 *      is far less harmful than false-success on a hidden git failure.
 *
 * Returns a `{ stdout, truncated }` shape on stdout-overflow, or `null`
 * to signal the caller should re-throw.
 */
export function classifyMaxBufferError(err) {
  if (!err || err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return null;
  const message = typeof err.message === 'string' ? err.message : '';
  const stdoutBuffer = err.stdout instanceof Buffer ? err.stdout : null;
  const stderrBuffer = err.stderr instanceof Buffer ? err.stderr : null;
  const stdoutOverflowSignal = message.includes('stdout maxBuffer')
    || (!message.includes('stderr maxBuffer') && stdoutBuffer && stdoutBuffer.length > 0);
  const stderrOverflowSignal = message.includes('stderr maxBuffer')
    || (!stdoutOverflowSignal && stderrBuffer && stderrBuffer.length > 0);
  if (stderrOverflowSignal && !stdoutOverflowSignal) return null;
  if (!stdoutOverflowSignal) return null;
  return {
    stdout: stdoutBuffer ? stdoutBuffer.slice(0, MAX_OUTPUT_BYTES).toString('utf8') : '',
    truncated: true,
  };
}

/**
 * Run a git command via execFile (no shell, no injection surface).
 * Returns stdout as a string truncated to MAX_OUTPUT_BYTES, with a flag
 * indicating whether truncation occurred.
 *
 * Why two byte limits: `execFile` rejects when stdout exceeds `maxBuffer`
 * with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. If we set `maxBuffer` to the
 * truncation cap, every oversized diff turns into a thrown error before
 * we ever see the output to truncate. Instead we let `execFile` capture
 * up to `EXEC_BUFFER_BYTES` (16 MiB), then slice to `MAX_OUTPUT_BYTES`
 * after the await. If a git invocation somehow exceeds 16 MiB on stdout
 * anyway (extremely unlikely on a single review-time command), we still
 * treat that as truncation rather than a tool failure. If the overflow
 * is on stderr, we re-throw — a 16 MiB error stream means the command
 * failed and the agent should see that.
 */
export async function runGit(cwd, args) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cwd is required');
  }
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('args is required');
  }
  let stdout;
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: EXEC_BUFFER_BYTES,
      encoding: 'buffer',
    });
    stdout = result.stdout;
  } catch (err) {
    const classified = classifyMaxBufferError(err);
    if (classified) return classified;
    throw err;
  }
  if (stdout.length > MAX_OUTPUT_BYTES) {
    return { stdout: stdout.slice(0, MAX_OUTPUT_BYTES).toString('utf8'), truncated: true };
  }
  return { stdout: stdout.toString('utf8'), truncated: false };
}
