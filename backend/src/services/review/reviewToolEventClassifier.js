/**
 * Classify a CLI-agentic tool_use event into a canonical kind for
 * Performance-mode telemetry (Milestone M0). Pure, no I/O, no logging.
 *
 * Event shape (from reviewProviderExecution.js onToolUse callback):
 *   { type: 'tool_use', name: string, input: object }
 *
 * Returned kinds:
 *   full_file_read     — Read with no offset/limit (entire file pulled in)
 *   partial_file_read  — Read with offset or limit set
 *   grep               — Grep / structured search
 *   glob               — Glob / file listing
 *   git_diff           — Bash invocation that runs `git diff` (any form)
 *   git_other          — Bash invocation that runs another git subcommand
 *   shell              — Other Bash invocation
 *   edit               — Edit / NotebookEdit / similar mutation tool
 *   write              — Write (whole-file mutation)
 *   web                — WebFetch / WebSearch
 *   mcp                — Tool name starts with mcp__
 *   other              — Recognized non-classified tool name
 *   unclassified       — Could not interpret the event at all
 *
 * The unclassified rate is the M0 reliability metric — it must stay below
 * 10% on the benchmark fixture set for telemetry to be considered usable
 * (and below 5% before M2 enforcement gates ship).
 */

const EDIT_TOOLS = new Set(['Edit', 'NotebookEdit']);
const WRITE_TOOLS = new Set(['Write']);
const GREP_TOOLS = new Set(['Grep']);
const GLOB_TOOLS = new Set(['Glob', 'LS']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const READ_TOOLS = new Set(['Read']);
const BASH_TOOLS = new Set(['Bash']);

/**
 * Section R Phase B runtime MCP tools — surfaced to the spawned CLI under
 * the `mcp__atlas-review-rt__*` namespace. Map them to canonical kinds so
 * telemetry shows what the agent actually did rather than a generic "mcp"
 * bucket. Without this mapping, four `get_diff_for_file` calls and four
 * `read_file_slice` calls would be indistinguishable in the rollup, even
 * though they exercise very different behaviors (per-file diff fetch vs
 * hunk slicing).
 */
const RUNTIME_MCP_PREFIX = 'mcp__atlas-review-rt__';
const RUNTIME_MCP_TOOL_KIND = {
  get_diff_for_file: 'git_diff',
  read_file_slice: 'partial_file_read',
  get_hunk_context: 'partial_file_read',
};

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull the most-likely "target" path from a tool input. Used as the dedupe
 * key for repeated-read tracking. Returns null when the tool does not have
 * a meaningful single-path target (Bash, Grep across many paths, etc.).
 */
function extractTarget(name, input) {
  if (!input || typeof input !== 'object') return null;
  if (READ_TOOLS.has(name) || EDIT_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    const p = asString(input.file_path) || asString(input.notebook_path);
    return p || null;
  }
  if (GREP_TOOLS.has(name) || GLOB_TOOLS.has(name)) {
    const p = asString(input.path);
    return p || null;
  }
  // Section R Phase B MCP tools all take a `path` arg; reuse it for
  // repeated-read tracking so a stuck "fetch the same file four times"
  // pattern is observable across both Read and the MCP retrieval tools.
  if (typeof name === 'string' && name.startsWith(RUNTIME_MCP_PREFIX)) {
    const p = asString(input.path);
    return p || null;
  }
  return null;
}

/**
 * Detect whether a Bash command is a `git diff` invocation. Matches:
 *   git diff
 *   git --no-pager diff
 *   git -c foo=bar diff ...
 * Avoids false positives on `git difftool`, `git diff-files`, `git diff-tree`,
 * and on commands that merely contain "git diff" as a substring of an arg.
 */
function isGitDiffCommand(command) {
  if (!command) return false;
  // Strip common shell prefix wrappers (`set -e;`, leading whitespace, env vars).
  const trimmed = command.trim();
  // Find the first `git ` token preceded by a shell separator (or start of line),
  // not generic whitespace — that avoids false positives on `echo "git diff"`
  // and similar quoted string args. Then walk past `-c` / `--no-pager` /
  // similar pre-subcommand options to the actual subcommand.
  const gitMatch = /(^|[;|&(])\s*git(\s+)/.exec(trimmed);
  if (!gitMatch) return false;
  const afterGit = trimmed.slice(gitMatch.index + gitMatch[0].length);
  // Tokenize loosely on whitespace; skip pre-subcommand flags.
  const tokens = afterGit.split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === '--no-pager' || tok === '-P' || tok === '--paginate') {
      i += 1;
      continue;
    }
    if (tok === '-c' || tok === '-C') {
      i += 2;
      continue;
    }
    if (tok.startsWith('--git-dir=') || tok.startsWith('--work-tree=')) {
      i += 1;
      continue;
    }
    break;
  }
  const subcommand = tokens[i] || '';
  return subcommand === 'diff';
}

function isGitInvocation(command) {
  if (!command) return false;
  // Same rationale as isGitDiffCommand: separator-anchored, not whitespace,
  // so that `echo "git ..."` doesn't get classified as a git invocation.
  return /(^|[;|&(])\s*git(\s|$)/.test(command.trim());
}

/**
 * Classify a single tool_use event. See module-level docs for kinds.
 */
export function classifyToolEvent(event) {
  if (!event || typeof event !== 'object') {
    return { kind: 'unclassified', target: null };
  }
  const name = asString(event.name);
  const input = event.input && typeof event.input === 'object' ? event.input : {};
  if (!name) {
    return { kind: 'unclassified', target: null };
  }

  if (READ_TOOLS.has(name)) {
    const offset = asNumber(input.offset);
    const limit = asNumber(input.limit);
    const isPartial = (offset !== null && offset > 0) || (limit !== null && limit > 0);
    return {
      kind: isPartial ? 'partial_file_read' : 'full_file_read',
      target: extractTarget(name, input),
    };
  }

  if (GREP_TOOLS.has(name)) {
    return { kind: 'grep', target: extractTarget(name, input) };
  }

  if (GLOB_TOOLS.has(name)) {
    return { kind: 'glob', target: extractTarget(name, input) };
  }

  if (EDIT_TOOLS.has(name)) {
    return { kind: 'edit', target: extractTarget(name, input) };
  }

  if (WRITE_TOOLS.has(name)) {
    return { kind: 'write', target: extractTarget(name, input) };
  }

  if (WEB_TOOLS.has(name)) {
    return { kind: 'web', target: null };
  }

  if (BASH_TOOLS.has(name)) {
    const command = asString(input.command);
    if (isGitDiffCommand(command)) {
      return { kind: 'git_diff', target: null };
    }
    if (isGitInvocation(command)) {
      return { kind: 'git_other', target: null };
    }
    return { kind: 'shell', target: null };
  }

  if (name.startsWith(RUNTIME_MCP_PREFIX)) {
    const toolName = name.slice(RUNTIME_MCP_PREFIX.length);
    const kind = RUNTIME_MCP_TOOL_KIND[toolName] || 'mcp';
    return { kind, target: extractTarget(name, input) };
  }

  if (name.startsWith('mcp__')) {
    return { kind: 'mcp', target: null };
  }

  return { kind: 'other', target: null };
}

/**
 * Constant export of the canonical kind list, for telemetry initialization
 * and tests. Order is stable; new kinds append.
 */
export const TOOL_EVENT_KINDS = Object.freeze([
  'full_file_read',
  'partial_file_read',
  'grep',
  'glob',
  'git_diff',
  'git_other',
  'shell',
  'edit',
  'write',
  'web',
  'mcp',
  'other',
  'unclassified',
]);

export const __testables = { isGitDiffCommand, isGitInvocation, extractTarget };
