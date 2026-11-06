import { spawn as defaultSpawn } from 'child_process';

export const BUILDER_RUN_POLICY = Object.freeze({
  createChangeset: true,
  autoCommit: true,
  autoPush: true,
  persistChatMessages: true,
  updateMemory: true,
});

export const REVIEW_FIX_RUN_POLICY = Object.freeze({
  createChangeset: true,
  autoCommit: false,
  autoPush: false,
  persistChatMessages: false,
  updateMemory: false,
});

export const REVIEW_AGENT_RUN_POLICY = Object.freeze({
  createChangeset: false,
  autoCommit: false,
  autoPush: false,
  persistChatMessages: false,
  updateMemory: false,
});

export const CLI_RUN_TYPES = Object.freeze({
  builder: 'builder',
  reviewFix: 'review_fix',
  reviewAgent: 'review_agent',
});

export const CLI_RUN_EVENT_TYPES = Object.freeze({
  started: 'started',
  system: 'system',
  assistantText: 'assistant-text',
  toolUse: 'tool-use',
  taskStatus: 'task-status',
  error: 'error',
  complete: 'complete',
  stopped: 'stopped',
  processError: 'process-error',
});

export const REVIEW_FIX_ACCEPTANCE_CRITERIA = Object.freeze([
  'Fix the selected finding without regressing surrounding behavior.',
  'Keep the patch scoped to the selected finding keys unless a tiny support edit is required.',
  'Leave the finding in verification_pending state after the patch. Do not mark it addressed.',
]);

export const REVIEW_FIX_CONSTRAINTS = Object.freeze([
  'Preserve the existing architecture and naming patterns in the touched files.',
  'Avoid unrelated refactors or opportunistic cleanup.',
  'Do not add new dependencies unless the fix is impossible without them.',
]);

export const REVIEW_FIX_NON_GOALS = Object.freeze([
  'Do not claim the finding is addressed just because the patch looks correct.',
  'Do not fix unrelated findings that were not selected for this run.',
  'Do not rewrite unaffected files to chase style-only cleanup.',
]);

function emitRunEvent(onEvent, type, data) {
  if (typeof onEvent !== 'function') {
    return Promise.resolve();
  }

  return Promise.resolve(onEvent({ type, data }));
}

function isIgnorableCliStderr({ providerType, text } = {}) {
  const normalizedProviderType = String(providerType || '').trim().toLowerCase();
  const normalizedText = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalizedText) {
    return true;
  }

  return normalizedProviderType === 'openai'
    && normalizedText.includes('codex_core::session')
    && normalizedText.includes('failed to record rollout items')
    && normalizedText.includes('thread')
    && normalizedText.includes('not found');
}

function normalizeReviewFixKey(rawKey) {
  return String(rawKey || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildReviewFixRecommendationLookup(reviewRecommendations = []) {
  const lookup = {};
  for (const recommendation of Array.isArray(reviewRecommendations) ? reviewRecommendations : []) {
    if (!recommendation || typeof recommendation !== 'object') {
      continue;
    }
    const key = normalizeReviewFixKey(recommendation.recommendationKey);
    if (!key || lookup[key]) {
      continue;
    }
    lookup[key] = recommendation;
  }
  return lookup;
}

function formatReviewFixAnchor(recommendation = {}) {
  const sourceFile = recommendation.sourceAnchor?.file || recommendation.file || recommendation.patchAnchor?.file || '';
  const sourceLine = recommendation.sourceAnchor?.line || recommendation.line || recommendation.patchAnchor?.line || null;
  if (sourceFile && sourceLine) {
    return `${sourceFile}:${sourceLine}`;
  }
  if (sourceFile) {
    return sourceFile;
  }
  return 'unanchored';
}

function resolveReviewFixSnippet(recommendation = {}) {
  const snippet = [
    recommendation.sourceAnchor?.snippet,
    recommendation.targetSnippet,
    recommendation.evidenceSnippet,
    recommendation.evidence?.snippet,
  ].find((value) => typeof value === 'string' && value.trim());

  return typeof snippet === 'string' && snippet.trim()
    ? snippet.trim()
    : 'No exact snippet was available in the persisted review payload.';
}

export function selectReviewFixRecommendations(reviewRecommendations = [], recommendationKeys = []) {
  const lookup = buildReviewFixRecommendationLookup(reviewRecommendations);
  return (Array.isArray(recommendationKeys) ? recommendationKeys : [])
    .map((key) => lookup[normalizeReviewFixKey(key)] || null)
    .filter(Boolean);
}

export function buildReviewFixPrompt({
  reviewType,
  reviewId,
  reviewSummary = '',
  reviewRecommendations = [],
  recommendationKeys = [],
} = {}) {
  const selectedRecommendations = selectReviewFixRecommendations(reviewRecommendations, recommendationKeys);
  const lines = [
    'You are running Atlas review_fix for selected review findings.',
    `Review scope: ${String(reviewType || 'unknown')} ${String(reviewId || '').trim()}`.trim(),
    'Goal: produce the smallest correct patch for the selected findings and stop at verification_pending.',
  ];

  const normalizedSummary = String(reviewSummary || '').trim();
  if (normalizedSummary) {
    lines.push(`Review summary: ${normalizedSummary}`);
  }

  lines.push('');
  lines.push('Acceptance criteria:');
  for (const item of REVIEW_FIX_ACCEPTANCE_CRITERIA) {
    lines.push(`- ${item}`);
  }

  lines.push('');
  lines.push('Constraints:');
  for (const item of REVIEW_FIX_CONSTRAINTS) {
    lines.push(`- ${item}`);
  }

  lines.push('');
  lines.push('Non-goals:');
  for (const item of REVIEW_FIX_NON_GOALS) {
    lines.push(`- ${item}`);
  }

  lines.push('');
  lines.push(`Selected finding count: ${selectedRecommendations.length}`);

  for (const [index, recommendation] of selectedRecommendations.entries()) {
    lines.push('');
    lines.push(`Selected finding ${index + 1}`);
    if (recommendation.findingId) {
      lines.push(`Finding ID: ${recommendation.findingId}`);
    }
    lines.push(`Recommendation key: ${recommendation.recommendationKey}`);
    lines.push(`Title: ${String(recommendation.title || '').trim()}`);
    lines.push(`Severity: ${String(recommendation.severity || '').trim().toLowerCase() || 'medium'}`);
    lines.push(`Why it matters: ${String(recommendation.description || '').trim() || 'No description provided.'}`);
    lines.push(`File/line anchor: ${formatReviewFixAnchor(recommendation)}`);
    lines.push('Exact snippet or diff hunk:');
    lines.push('```');
    lines.push(resolveReviewFixSnippet(recommendation));
    lines.push('```');
    if (typeof recommendation.suggestedFix === 'string' && recommendation.suggestedFix.trim()) {
      lines.push('Suggested fix from review:');
      lines.push('```');
      lines.push(recommendation.suggestedFix.trim());
      lines.push('```');
    }
  }

  return lines.join('\n').trim();
}

function appendCodexAssistantText({
  cliAdapter,
  adapterResult,
  normalized,
  text,
  codexDeltaTextByItemId,
}) {
  if (!text) {
    return '';
  }

  const isCodexStructuredStream = cliAdapter.getType() === 'openai' && Boolean(adapterResult.structuredOutput);
  if (!isCodexStructuredStream) {
    return text;
  }

  const rawType = normalized?.raw?.type;
  const itemId = normalized?.raw?.item?.id;
  if (!itemId || typeof rawType !== 'string') {
    return text;
  }

  if (rawType === 'item.delta') {
    const previous = codexDeltaTextByItemId.get(itemId) || '';
    codexDeltaTextByItemId.set(itemId, previous + text);
    return text;
  }

  if (rawType === 'item.completed') {
    const previous = codexDeltaTextByItemId.get(itemId) || '';
    codexDeltaTextByItemId.delete(itemId);

    if (!previous) {
      return text;
    }

    if (text === previous) {
      return '';
    }

    if (text.startsWith(previous)) {
      return text.slice(previous.length);
    }
  }

  return text;
}

async function flushStructuredBuffer({
  buffer,
  cliAdapter,
  adapterResult,
  processNormalizedEvent,
}) {
  if (!buffer.trim()) {
    return '';
  }

  const normalized = cliAdapter.parseStreamLine(buffer);
  if (normalized) {
    await processNormalizedEvent(normalized);
  }

  return '';
}

export function resolveRunPolicy(basePolicy = BUILDER_RUN_POLICY, overrides = {}) {
  return {
    ...BUILDER_RUN_POLICY,
    ...(basePolicy || {}),
    ...(overrides || {}),
  };
}

export function createCliRunExecutor({
  spawnProcess = defaultSpawn,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  return {
    start(options) {
      const {
        projectId,
        projectPath,
        runType = CLI_RUN_TYPES.builder,
        cliAdapter,
        providerType,
        adapterResult = {},
        cliBinaryPath,
        cliLaunchArgs = [],
        spawnEnv,
        inactivityTimeoutMs,
        inactivityTimeoutLabel,
        policy = BUILDER_RUN_POLICY,
        onEvent,
      } = options;

      const resolvedPolicy = resolveRunPolicy(policy);
      const startedAt = Date.now();

      let assistantMessage = '';
      let tokensUsed = 0;
      let model = cliAdapter.getDefaultModel?.() || null;
      let stdoutBuffer = '';
      let lastStreamError = '';
      let stderrBuffer = '';
      let stopRequested = false;
      const toolUseEvents = [];
      const codexDeltaTextByItemId = new Map();
      const stderrMaxBytes = 10240;

      const cliProcess = spawnProcess(cliBinaryPath, cliLaunchArgs, {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
      });

      const controller = {
        projectId,
        runType,
        startedAt,
        policy: resolvedPolicy,
        process: cliProcess,
        async stop(signal = 'SIGTERM') {
          stopRequested = true;
          cliProcess.kill(signal);
        },
      };

      emitRunEvent(onEvent, CLI_RUN_EVENT_TYPES.started, {
        projectId,
        runType,
        startedAt: new Date(startedAt).toISOString(),
        policy: resolvedPolicy,
      });

      if (adapterResult.stdinMessage && adapterResult.message) {
        cliProcess.stdin.on('error', () => {}); // Prevent unhandled stream error if child exits early
        cliProcess.stdin.write(adapterResult.message);
        cliProcess.stdin.end();
      }

      let inactivityTimer = setTimeoutFn(() => {
        try {
          cliProcess.kill('SIGTERM');
        } catch {
          // Best effort only.
        }
        emitRunEvent(onEvent, CLI_RUN_EVENT_TYPES.error, {
          error: `AI provider stopped responding after ${inactivityTimeoutLabel}. The model may have timed out — please try again.`,
        });
      }, inactivityTimeoutMs);

      const resetInactivityTimer = () => {
        clearTimeoutFn(inactivityTimer);
        inactivityTimer = setTimeoutFn(() => {
          try {
            cliProcess.kill('SIGTERM');
          } catch {
            // Best effort only.
          }
          emitRunEvent(onEvent, CLI_RUN_EVENT_TYPES.error, {
            error: `AI provider stopped responding after ${inactivityTimeoutLabel}. The model may have timed out — please try again.`,
          });
        }, inactivityTimeoutMs);
      };

      const processNormalizedEvent = async (normalized) => {
        switch (normalized.type) {
          case 'session_meta':
          case 'system':
            if (normalized.model) {
              model = normalized.model;
            }
            await emitRunEvent(onEvent, CLI_RUN_EVENT_TYPES.system, normalized.raw || normalized);
            break;
          case 'assistant': {
            if (normalized.model) {
              model = normalized.model;
            }

            const contentBlocks = normalized.contentBlocks || [];
            for (const block of contentBlocks) {
              if (block.type === 'text' && block.text) {
                const textToAppend = appendCodexAssistantText({
                  cliAdapter,
                  adapterResult,
                  normalized,
                  text: block.text,
                  codexDeltaTextByItemId,
                });

                if (!textToAppend) {
                  continue;
                }

                assistantMessage += textToAppend;
                await emitRunEvent(onEvent, CLI_RUN_EVENT_TYPES.assistantText, {
                  text: textToAppend,
                });
                continue;
              }

              if (block.type === 'tool_use') {
                const toolEvent = {
                  id: block.toolId,
                  name: block.toolName,
                  input: block.toolInput,
                };
                toolUseEvents.push(toolEvent);
                await emitRunEvent(onEvent, CLI_RUN_EVENT_TYPES.toolUse, toolEvent);

                const taskId = block.toolInput?.taskId || block.toolInput?.id;
                const status = block.toolInput?.status;
                if (block.toolName === 'TaskUpdate' && taskId && status) {
                  await emitRunEvent(onEvent, CLI_RUN_EVENT_TYPES.taskStatus, {
                    taskId,
                    status,
                    timestamp: new Date().toISOString(),
                  });
                }
              }
            }

            if (normalized.tokensUsed) {
              tokensUsed = normalized.tokensUsed;
            }
            break;
          }
          case 'result':
            if (normalized.tokensUsed) {
              tokensUsed = normalized.tokensUsed;
            }
            break;
          case 'error':
            lastStreamError = normalized.message || 'CLI stream error';
            void emitRunEvent(onEvent, CLI_RUN_EVENT_TYPES.error, {
              error: lastStreamError,
            });
            break;
          default:
            break;
        }
      };

      const done = new Promise((resolve, reject) => {
        cliProcess.stdout.on('data', async (data) => {
          resetInactivityTimer();
          stdoutBuffer += data.toString();
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() || '';

          const isStructuredOutput = adapterResult.structuredOutput ?? !adapterResult.stdinMessage;
          const completeLines = isStructuredOutput
            ? lines.filter((line) => line.trim())
            : lines;

          for (const line of completeLines) {
            const normalized = cliAdapter.parseStreamLine(line);
            if (!normalized) {
              continue;
            }
            await processNormalizedEvent(normalized);
          }
        });

        cliProcess.stderr.on('data', (data) => {
          const stderrOutput = data.toString();
          stderrBuffer += stderrOutput;
          if (stderrBuffer.length > stderrMaxBytes) {
            stderrBuffer = stderrBuffer.slice(-stderrMaxBytes);
          }

          if (
            !isIgnorableCliStderr({ providerType, text: stderrOutput })
            && (stderrOutput.toLowerCase().includes('error') || stderrOutput.toLowerCase().includes('failed'))
          ) {
            void emitRunEvent(onEvent, CLI_RUN_EVENT_TYPES.error, {
              error: stderrOutput,
            });
          }
        });

        cliProcess.on('close', async (code) => {
          clearTimeoutFn(inactivityTimer);
          stdoutBuffer = await flushStructuredBuffer({
            buffer: stdoutBuffer,
            cliAdapter,
            adapterResult,
            processNormalizedEvent,
          });

          const result = {
            status: stopRequested ? 'stopped' : 'completed',
            exitCode: code,
            assistantMessage,
            toolUseEvents,
            tokensUsed,
            model,
            providerType,
            policy: resolvedPolicy,
            stderrBuffer,
            lastStreamError,
          };

          await emitRunEvent(
            onEvent,
            stopRequested ? CLI_RUN_EVENT_TYPES.stopped : CLI_RUN_EVENT_TYPES.complete,
            result,
          );
          resolve(result);
        });

        cliProcess.on('error', (error) => {
          clearTimeoutFn(inactivityTimer);
          emitRunEvent(onEvent, CLI_RUN_EVENT_TYPES.processError, {
            error: error.message,
          });
          reject(error);
        });
      });

      return {
        controller,
        done,
      };
    },
  };
}
