/**
 * OpenCode Streaming Chat — Direct API streaming functions for builder chat.
 *
 * When `opencode run` CLI is broken upstream, these functions bypass the CLI
 * and call provider HTTP APIs directly with streaming enabled, yielding
 * normalized text chunks that the server.js ai-message handler can emit
 * via the existing socket event protocol.
 *
 * Each generator yields:
 *   { type: 'text', text: '...' }   — incremental text chunk
 *   { type: 'done', tokensUsed: number, model: string }  — stream complete
 *
 * These are text-only chat streams (no tool use, no file editing).
 */

const STREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Gemini (Google) streaming
// ---------------------------------------------------------------------------

/**
 * Stream a chat completion from the Gemini API.
 * Uses the streamGenerateContent endpoint with SSE.
 *
 * @param {string} apiKey
 * @param {string} model - Bare model name (e.g. "gemini-2.5-flash")
 * @param {string} userMessage - The user's message
 * @param {string} [systemPrompt] - Optional system instruction
 * @param {{ signal?: AbortSignal }} [options] - Optional abort signal for cancellation
 * @yields {{ type: 'text', text: string } | { type: 'done', tokensUsed: number, model: string }}
 */
export async function* streamGeminiChat(apiKey, model, userMessage, systemPrompt, options = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const body = {
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig: { maxOutputTokens: 16384 },
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  if (typeof timer?.unref === 'function') timer.unref();
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`Gemini API request failed: ${error.message}`);
  }

  if (!response.ok) {
    clearTimeout(timer);
    const errBody = await response.json().catch(() => ({}));
    const msg = errBody?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini API error: ${msg}`);
  }

  let totalTokens = 0;
  try {
    yield* parseSSEStream(response.body, (data) => {
      // Each SSE data line is a JSON object with candidates and usageMetadata
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      const usage = data?.usageMetadata;
      if (usage) {
        totalTokens = (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0);
      }
      if (text) {
        return { type: 'text', text };
      }
      return null;
    });
  } finally {
    clearTimeout(timer);
  }

  yield { type: 'done', tokensUsed: totalTokens, model: `google/${model}` };
}

// ---------------------------------------------------------------------------
// Anthropic streaming
// ---------------------------------------------------------------------------

/**
 * Stream a chat completion from the Anthropic Messages API.
 *
 * @param {string} apiKey
 * @param {string} model - Bare model name (e.g. "claude-sonnet-4-20250514")
 * @param {string} userMessage
 * @param {string} [systemPrompt]
 * @param {{ signal?: AbortSignal }} [options] - Optional abort signal for cancellation
 * @yields {{ type: 'text', text: string } | { type: 'done', tokensUsed: number, model: string }}
 */
export async function* streamAnthropicChat(apiKey, model, userMessage, systemPrompt, options = {}) {
  const requestBody = {
    model,
    max_tokens: 16384,
    stream: true,
    messages: [{ role: 'user', content: userMessage }],
  };
  if (systemPrompt) {
    requestBody.system = systemPrompt;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  if (typeof timer?.unref === 'function') timer.unref();
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`Anthropic API request failed: ${error.message}`);
  }

  if (!response.ok) {
    clearTimeout(timer);
    const errBody = await response.json().catch(() => ({}));
    const msg = errBody?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Anthropic API error: ${msg}`);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  try {
    // Anthropic SSE events have `event:` lines followed by `data:` lines
    // message_start contains input_tokens; message_delta contains output_tokens only
    yield* parseAnthropicSSE(response.body, (event, data) => {
      if (event === 'content_block_delta' && data?.delta?.type === 'text_delta') {
        return { type: 'text', text: data.delta.text };
      }
      if (event === 'message_start' && data?.message?.usage) {
        inputTokens = data.message.usage.input_tokens || 0;
      }
      if (event === 'message_delta' && data?.usage) {
        outputTokens = data.usage.output_tokens || 0;
      }
      return null;
    });
  } finally {
    clearTimeout(timer);
  }

  yield { type: 'done', tokensUsed: inputTokens + outputTokens, model: `anthropic/${model}` };
}

// ---------------------------------------------------------------------------
// OpenAI streaming
// ---------------------------------------------------------------------------

/**
 * Stream a chat completion from the OpenAI API.
 *
 * @param {string} apiKey
 * @param {string} model - Bare model name (e.g. "gpt-4o")
 * @param {string} userMessage
 * @param {string} [systemPrompt]
 * @param {{ signal?: AbortSignal }} [options] - Optional abort signal for cancellation
 * @yields {{ type: 'text', text: string } | { type: 'done', tokensUsed: number, model: string }}
 */
export async function* streamOpenAIChat(apiKey, model, userMessage, systemPrompt, options = {}) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userMessage });

  const requestBody = {
    model,
    max_tokens: 16384,
    stream: true,
    stream_options: { include_usage: true },
    messages,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  if (typeof timer?.unref === 'function') timer.unref();
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`OpenAI API request failed: ${error.message}`);
  }

  if (!response.ok) {
    clearTimeout(timer);
    const errBody = await response.json().catch(() => ({}));
    const msg = errBody?.error?.message || `HTTP ${response.status}`;
    throw new Error(`OpenAI API error: ${msg}`);
  }

  let totalTokens = 0;
  try {
    yield* parseSSEStream(response.body, (data) => {
      // OpenAI sends [DONE] as a sentinel — skip it
      if (data === '[DONE]') return null;

      // Usage comes in the final chunk when stream_options.include_usage is true
      if (data?.usage) {
        totalTokens = (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
      }

      const text = data?.choices?.[0]?.delta?.content;
      if (text) {
        return { type: 'text', text };
      }
      return null;
    });
  } finally {
    clearTimeout(timer);
  }

  yield { type: 'done', tokensUsed: totalTokens, model: `openai/${model}` };
}

// ---------------------------------------------------------------------------
// NVIDIA NIM streaming (OpenAI-compatible)
// ---------------------------------------------------------------------------

/**
 * Stream a chat completion from the NVIDIA NIM API.
 *
 * @param {string} apiKey
 * @param {string} model - Bare model name (e.g. "meta/llama-3.1-8b-instruct")
 * @param {string} userMessage
 * @param {string} [systemPrompt]
 * @param {{ signal?: AbortSignal }} [options] - Optional abort signal for cancellation
 * @yields {{ type: 'text', text: string } | { type: 'done', tokensUsed: number, model: string }}
 */
export async function* streamNvidiaChat(apiKey, model, userMessage, systemPrompt, options = {}) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: userMessage });

  const requestBody = {
    model,
    max_tokens: 16384,
    stream: true,
    messages,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  if (typeof timer?.unref === 'function') timer.unref();
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let response;
  try {
    response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`NVIDIA NIM API request failed: ${error.message}`);
  }

  if (!response.ok) {
    clearTimeout(timer);
    const errBody = await response.json().catch(() => ({}));
    const msg = errBody?.error?.message || `HTTP ${response.status}`;
    throw new Error(`NVIDIA NIM API error: ${msg}`);
  }

  let totalTokens = 0;
  try {
    yield* parseSSEStream(response.body, (data) => {
      if (data === '[DONE]') return null;

      if (data?.usage) {
        totalTokens = (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
      }

      const text = data?.choices?.[0]?.delta?.content;
      if (text) {
        return { type: 'text', text };
      }
      return null;
    });
  } finally {
    clearTimeout(timer);
  }

  yield { type: 'done', tokensUsed: totalTokens, model: `nvidia/${model}` };
}

// ---------------------------------------------------------------------------
// SSE parsing helpers
// ---------------------------------------------------------------------------

/**
 * Generic SSE parser for providers that use standard `data: {...}\n\n` format
 * (Gemini, OpenAI, NVIDIA).
 *
 * @param {ReadableStream} body - The response body stream
 * @param {(data: any) => { type: string, text: string } | null} handler
 *   Called with each parsed JSON data payload. Return a chunk to yield or null to skip.
 * @yields {*} Whatever the handler returns (non-null)
 */
async function* parseSSEStream(body, handler) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    // Process complete SSE events (separated by double newlines)
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') {
          const result = handler('[DONE]');
          if (result) yield result;
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue; // Skip malformed JSON
        }
        const result = handler(parsed);
        if (result) yield result;
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const result = handler(parsed);
      if (result) yield result;
    }
  }
}

/**
 * Anthropic-specific SSE parser. Anthropic uses `event: <type>\ndata: {...}\n\n`
 * format where the event type determines the data shape.
 *
 * @param {ReadableStream} body
 * @param {(event: string, data: any) => { type: string, text: string } | null} handler
 * @yields {*}
 */
async function* parseAnthropicSSE(body, handler) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      let event = null;
      let data = null;

      for (const line of part.split('\n')) {
        if (line.startsWith('event: ')) {
          event = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim();
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }

      if (event && data) {
        const result = handler(event, data);
        if (result) yield result;
      }
    }
  }

  // Flush remaining
  if (buffer.trim()) {
    let event = null;
    let data = null;
    for (const line of buffer.split('\n')) {
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        const raw = line.slice(6).trim();
        if (raw) {
          try { data = JSON.parse(raw); } catch { /* skip */ }
        }
      }
    }
    if (event && data) {
      const result = handler(event, data);
      if (result) yield result;
    }
  }
}

/**
 * Map of provider type to streaming function.
 * Used by the server.js bypass to look up the right stream function.
 */
export const STREAMING_FUNCTIONS = {
  google: streamGeminiChat,
  anthropic: streamAnthropicChat,
  openai: streamOpenAIChat,
  nvidia: streamNvidiaChat,
};
