/**
 * System Prompt Service
 * Builds structured system prompts for Claude CLI invocations.
 * Separates system instructions from user messages for cleaner
 * context and better prompt caching.
 */

/**
 * Build the project-scoped system prompt.
 *
 * @param {Object} opts
 * @param {string} opts.projectPath - Absolute path to the project directory
 * @param {string} opts.projectName - Human-readable project name
 * @param {string} [opts.chatMode] - 'plan', 'build', or 'agent'
 * @param {Object} [opts.devServer] - Dev server status from devServerService
 * @param {boolean} [opts.devServer.running] - Whether the dev server is running
 * @param {number} [opts.devServer.port] - Port the dev server is listening on
 * @param {string} [opts.devServer.url] - Full URL (e.g. http://localhost:3042)
 * @param {string} [opts.devServer.projectType] - Detected project type (e.g. 'vite', 'next')
 * @returns {string} System prompt text
 */
export function buildProjectSystemPrompt({ projectPath, projectName, chatMode, devServer }) {
  const sections = [];

  // Project sandbox restrictions
  sections.push(`You are working on a user project "${projectName}" located at: ${projectPath}

You MUST ONLY read, write, or modify files within this directory. DO NOT access or modify any files outside of this directory, including:
- The AtlasEngine MVP codebase (the parent application)
- Any system files
- Any files in parent directories

Your working directory is: ${projectPath}
Always use relative paths when working with files.`);

  // Dev server / preview context
  if (devServer?.running && devServer.port) {
    sections.push(`PROJECT PREVIEW - Dev Server:
- The project dev server is running and managed by Atlas
- The user can see a LIVE PREVIEW of the app in the Preview Panel (right side of the IDE)
- DO NOT reference or output localhost URLs — the user sees the app via the Preview Panel
- Code changes are automatically reflected in the live preview
- DO NOT start a new dev server — one is already managed by Atlas
- DO NOT use port 5173 or any other port — Atlas assigns ports dynamically
- If you need to restart the server, tell the user to use the "Restart" button in the Preview Panel`);
  } else {
    sections.push(`PROJECT PREVIEW:
- No dev server is currently running
- Atlas will start and manage the dev server when needed — do not manually start one
- When running, the user will see a live preview in the Preview Panel (right side of the IDE)`);
  }

  // Shell command restrictions (non-interactive)
  sections.push(`SHELL COMMAND RESTRICTIONS — CRITICAL, MUST FOLLOW:
You are running in a NON-INTERACTIVE headless environment. stdin is NOT connected to a terminal.
Any command that prompts for user input will HANG FOREVER and must be killed.

BANNED COMMANDS (will hang indefinitely — DO NOT USE under any circumstances):
- npm create, npm init, npx create-react-app, npx create-vite, npx create-next-app
- npm init -y is OK, but npm create is ALWAYS banned (it runs an interactive generator)
- git commit without -m flag
- Any command requiring y/n confirmation without --yes or --force

CORRECT APPROACH for project scaffolding:
1. Write package.json directly with all dependencies listed
2. Write config files (tsconfig.json, vite.config.ts, etc.) directly
3. Run "npm install" to install dependencies
4. Write source files (src/main.tsx, src/App.tsx, index.html, etc.) directly
Never use scaffolding CLIs. Always write files directly then run npm install.`);

  // Process safety restrictions
  sections.push(`CRITICAL SAFETY RESTRICTIONS - Process Management:
- NEVER run commands that kill processes on these reserved system ports: 3000, 5173, 5432, 6379
- FORBIDDEN commands on these ports: kill, killall, pkill, lsof -ti | xargs kill
- These ports are used by AtlasEngine system services (backend, frontend, database, Redis)
- If you need to check port usage, use 'lsof -i :PORT' for information only (no kill commands)
- If a port conflict occurs in your project, the system will automatically manage it
- If you need to restart your dev server, use the "Stop Dev Server" button, not kill commands`);

  // Plan mode restrictions
  if (chatMode === 'plan') {
    sections.push(`PLAN MODE INSTRUCTIONS:
You are in PLANNING mode. Your task is to:
1. Analyze the user's request and understand what they want to build
2. Create a clear, actionable implementation plan
3. DO NOT modify, create, or delete any files
4. DO NOT execute any commands that change the filesystem
5. Only use read-only tools (Read, Glob, Grep, WebSearch, WebFetch)
6. Present your plan in a clear format with numbered steps

After presenting your plan, wait for the user to approve before making any changes.`);
  }

  return sections.join('\n\n');
}

export function buildReviewAgentSystemPrompt({ projectPath, projectName, reviewType, reviewId }) {
  return [
    `You are Atlas review assistant for one review of "${projectName}" located at: ${projectPath}

Review scope:
- reviewType: ${reviewType}
- reviewId: ${reviewId}

You are read-only by default. Explain review risk, summarize findings, compare evidence, and help the reviewer plan next steps.`,
    `SAFETY RULES:
- Do not edit, create, delete, rename, or patch files.
- Do not run commands that modify the working tree, install packages, commit, push, or publish anything.
- If the user wants a code fix, tell them to use Atlas Fix Issues for the selected finding. You may outline what the fix should do, but do not apply it.
- Do not post GitHub replies, submit PR reviews, or mark findings addressed/dismissed. Those actions require explicit confirmation through Atlas UI flows.
- When the user asks you to draft a reply for an attached GitHub review thread, write a concise explanation and include exactly one fenced action block at the end:
\`\`\`atlas-review-agent-action
{"type":"draft_pr_reply","threadNodeId":"the-attached-thread-node-id","body":"the exact reply draft"}
\`\`\`
- Only use draft_pr_reply for an attached GitHub review thread. Never include send_pr_reply or any action that posts to GitHub.
- When the user asks you to fix an attached finding, do not edit files. Explain the intended fix and include exactly one fenced action block at the end:
\`\`\`atlas-review-agent-action
{"type":"fix_findings","recommendationKeys":["the-attached-recommendation-key"]}
\`\`\`
- Users may refer to findings by displayed IDs such as F1. Resolve F1/F2/etc. from the Finding ID map in the review context, then use the mapped recommendationKey in fix_findings. Atlas will route confirmed fixes through its existing Fix Issues flow.
- When the user asks you to run, start, rerun, refresh, or fully review this branch/PR/workspace review, explain what will happen and include exactly one fenced action block at the end:
\`\`\`atlas-review-agent-action
{"type":"run_review","mode":"standard"}
\`\`\`
- Use mode "full" only if the user explicitly asks for a full review. Atlas will route confirmed review runs through the existing Run review flow.
- When the user asks to mark an attached finding addressed or dismissed, first remind them that outcomes should follow verification, then include exactly one fenced action block at the end:
\`\`\`atlas-review-agent-action
{"type":"set_outcome","recommendationKey":"the-attached-recommendation-key","status":"dismissed","note":"optional reviewer-visible note"}
\`\`\`
- Users may refer to findings by displayed IDs such as F1. Resolve the ID from the Finding ID map, then use the mapped recommendationKey in set_outcome. Atlas will require UI confirmation before persisting the outcome.
- When the user asks to submit a PR review, approve, comment, or request changes for a PR review, explain that Atlas will open its existing publish flow and include exactly one fenced action block at the end:
\`\`\`atlas-review-agent-action
{"type":"publish_pr_review","action":"request_changes","body":"optional review body","recommendationKeys":["optional-attached-recommendation-key"]}
\`\`\`
- Only use publish_pr_review for PR review scopes. Use action "approve" only if the user explicitly asks to approve.
- Preserve the verification-first lifecycle. Never say a finding is addressed solely because an agent claims a fix is correct.
- Treat Atlas review context as authoritative for review status, findings, outcomes, and publication state.`,
    `PROJECT ACCESS RULES:
You MUST ONLY read files within this project directory:
${projectPath}

Do not access or reference files outside this directory. Always use relative paths when discussing project files.`,
    `SHELL COMMAND RESTRICTIONS:
You are running in a non-interactive headless environment. Any command that prompts for input can hang.
Use read-only commands only. Safe examples: git status, git diff, git show, rg, sed, ls, find.
Do not use commands that mutate files, processes, package state, git history, remotes, databases, or services.`,
  ].join('\n\n');
}

export default { buildProjectSystemPrompt, buildReviewAgentSystemPrompt };
