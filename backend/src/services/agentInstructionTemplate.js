import path from 'path';

export const ATLAS_AGENT_INSTRUCTION_BLOCK_START = '<!-- atlas-review-mcp:start -->';
export const ATLAS_AGENT_INSTRUCTION_BLOCK_END = '<!-- atlas-review-mcp:end -->';

export const INSTRUCTION_TARGETS = Object.freeze({
  codex: {
    id: 'codex',
    filePath: 'AGENTS.md',
    label: 'Codex',
  },
  cursor: {
    id: 'cursor',
    filePath: '.cursorrules',
    label: 'Cursor',
  },
  copilot: {
    id: 'copilot',
    filePath: path.join('.github', 'copilot-instructions.md'),
    label: 'GitHub Copilot',
  },
  vscode: {
    id: 'vscode',
    filePath: path.join('.github', 'copilot-instructions.md'),
    label: 'VS Code',
  },
  windsurf: {
    id: 'windsurf',
    filePath: '.windsurfrules',
    label: 'Windsurf',
  },
});

export function isSupportedInstructionTarget(target) {
  return Boolean(resolveInstructionTarget(target));
}

export function resolveInstructionTarget(target) {
  if (typeof target !== 'string') return null;
  const normalized = target.trim().toLowerCase();
  return INSTRUCTION_TARGETS[normalized] || null;
}

export function renderAtlasInstructionBlock(options = {}) {
  const {
    blockStart = ATLAS_AGENT_INSTRUCTION_BLOCK_START,
    blockEnd = ATLAS_AGENT_INSTRUCTION_BLOCK_END,
  } = options;

  return [
    blockStart,
    '## Atlas Review (MCP)',
    '',
    'Use Atlas MCP when:',
    '- the user explicitly asks to use Atlas review, Atlas MCP, or Atlas to find issues',
    '- the user asks to validate, fix, address, dismiss, or persist existing Atlas findings',
    '- you need authoritative Atlas review status, findings, or outcome tracking for an Atlas-scoped request',
    '',
    'Do not use Atlas MCP just because code changes are complete or local checks passed. For ordinary implementation tasks, validate with focused local tests unless the user explicitly asks for Atlas.',
    '',
    'Recommended workflow:',
    '1. `atlas://review/current` or `atlas_review_status` to inspect current Atlas review context',
    '2. `atlas_review_run_current` if no completed review exists for the current branch or PR snapshot',
    '3. `atlas_review_wait_for_terminal` after queueing or when Atlas reports an active review; repeat it until terminal if the review is still active',
    '4. `atlas_review_latest` to read summary, risk, and findings after terminal completion',
    '5. `atlas_review_file` to inspect a specific file',
    '6. `atlas_review_outcome_set` after a finding is addressed or dismissed',
    '7. `atlas_review_outcome_get` or `atlas_review_latest` to confirm the persisted outcomes before concluding',
    '',
    'Rules:',
    '- Do not cancel a running review based on elapsed time alone',
    '- Only use `atlas_review_queue_cancel` if the user asks to stop the review or Atlas shows the run is stale',
    '- Omit `projectId` unless you know the exact Atlas backend project id; do not guess `projectId` from the repository or directory name',
    '- Atlas supports branch review and PR review targets',
    '- When the user asks for a PR review, always use explicit PR targeting such as `reviewType: "pr_review"` with `githubPrNumber` or `prReviewId`; do not rely on current-review fallback',
    '- PR review execution through `atlas_review_run_current` is queue-only; do not pass `mode: "immediate"` for PR review',
    '- If Atlas findings are fixed or intentionally dismissed in the same turn, you MUST call `atlas_review_outcome_set` for each affected finding before concluding',
    '- Do not claim an Atlas finding is fixed until its outcome has been persisted in Atlas',
    blockEnd,
  ].join('\n');
}
