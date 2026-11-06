/**
 * Project Naming Service
 * Generates concise project names from first-turn chat context using a fast model.
 */

import { execFile } from 'child_process';
import providerService from './providerService.js';
import { findClaudeBinary } from '../utils/claudeBinary.js';

const TIMEOUT_MS = 10_000;
const MAX_NAME_LENGTH = 50;
const MAX_WORDS = 4;

export const AUTO_PROJECT_PLACEHOLDER = 'untitled-project';

const ATTACHMENT_STOP_WORD_RE = /^(spec|specs|requirement|requirements|prd|brief|doc|docs|document|draft|final|notes?|copy|v\d+)$/i;

/**
 * Leading filler phrases commonly seen in chat prompts.
 * Order matters — longer/more specific phrases first to avoid partial matches.
 */
const FILLER_PHRASES = [
  'i would like you to',
  'i would like to',
  'i want you to',
  'can you please',
  'could you please',
  'please help me',
  'i am going to',
  'i want to',
  'i need to',
  'i am looking to',
  'i am trying to',
  'help me',
  'can you',
  'could you',
  'i need an',
  'i need a',
  'i want an',
  'i want a',
  'lets build',
  "let's build",
  'lets create',
  "let's create",
  'lets make',
  "let's make",
  'build me an',
  'build me a',
  'create me an',
  'create me a',
  'make me an',
  'make me a',
  'build an',
  'build a',
  'create an',
  'create a',
  'make an',
  'make a',
  'please',
];

/**
 * Words that carry no meaning for a project name.
 */
const FILLER_WORDS = new Set([
  // articles & conjunctions
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'that', 'this',
  'from', 'into', 'using', 'like', 'some', 'just', 'also', 'very',
  // adjectives that don't describe a project
  'really', 'basically', 'simple', 'new', 'nice', 'good', 'great',
  'cool', 'awesome', 'pretty', 'little', 'small', 'big',
  // pronouns
  'me', 'my', 'i', 'we', 'our', 'it', 'its',
  // action verbs (user intent, not project identity)
  'build', 'create', 'make', 'develop', 'write', 'code', 'implement',
  'design', 'set', 'up', 'setup', 'add', 'generate', 'do', 'going',
  // misc
  'here', 'heres', 'ill', 'will', 'would', 'should', 'can', 'could',
  'have', 'has', 'need', 'want', 'get', 'got', 'be', 'been', 'being',
  'am', 'to', 'so', 'if', 'of', 'on', 'in', 'at', 'by', 'is', 'was',
  'modern', 'full', 'stack', 'fullstack', 'responsive', 'beautiful',
  'professional', 'sleek', 'clean', 'minimal', 'complete',
  // generic project type words (keep domain-specific nouns instead)
  'website', 'site', 'app', 'application', 'platform', 'tool',
  'system', 'software', 'page', 'web',
]);

/**
 * Strip leading filler phrases and trailing filler words from a prompt
 * to extract the meaningful core for fallback naming.
 */
function stripFillerFromPrompt(text) {
  let cleaned = String(text || '').trim().toLowerCase();
  if (!cleaned) return '';

  // Strip leading filler phrases (greedy, repeat until stable)
  // Match only at word boundaries to avoid partial word consumption
  let prev;
  do {
    prev = cleaned;
    for (const phrase of FILLER_PHRASES) {
      if (!cleaned.startsWith(phrase)) continue;
      const afterPhrase = cleaned[phrase.length];
      // Must be followed by a space, end of string, or non-alpha (word boundary)
      if (afterPhrase && /[a-z0-9]/.test(afterPhrase)) continue;
      cleaned = cleaned.slice(phrase.length).trim();
      break;
    }
  } while (cleaned !== prev);

  // Split into raw words for multi-pass filtering
  const rawWords = cleaned.split(/[^a-z0-9]+/).filter(Boolean);

  // First pass: drop all filler words (including generic project types)
  const meaningful = rawWords.filter((w) => !FILLER_WORDS.has(w));
  if (meaningful.length > 0) return meaningful.join(' ');

  // Second pass: if nothing meaningful remains, keep generic project-type
  // words (website, app, etc.) so prompts like "build me a website" still
  // produce a usable fallback name instead of collapsing to empty string.
  const GENERIC_PROJECT_WORDS = new Set([
    'website', 'site', 'app', 'application', 'platform', 'tool',
    'system', 'software', 'page', 'web',
  ]);
  const generic = rawWords.filter((w) => GENERIC_PROJECT_WORDS.has(w));
  return generic.join(' ');
}

function truncate(value, maxLength = 900) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function toKebabCase(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function deriveAttachmentStem(fileName) {
  const withoutExtension = String(fileName || '').replace(/\.[^.]+$/, '');
  const tokens = withoutExtension
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const filtered = tokens.filter((token) => !ATTACHMENT_STOP_WORD_RE.test(token));
  return filtered.length > 0 ? filtered.join(' ') : withoutExtension;
}

function normalizeAttachmentNames(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (!item) return '';
      if (typeof item === 'string') return item.trim();
      return String(item.originalName || item.filename || item.name || '').trim();
    })
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeAttachmentSummaries(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => truncate(item, 400))
    .filter(Boolean)
    .slice(0, 4);
}

function normalizeNamingInput(input) {
  if (typeof input === 'string') {
    return {
      userPrompt: truncate(input, 500),
      projectDescription: '',
      assistantResponse: '',
      attachmentNames: [],
      attachmentSummaries: [],
    };
  }

  const payload = input && typeof input === 'object' ? input : {};
  return {
    userPrompt: truncate(payload.userPrompt || payload.prompt || '', 500),
    projectDescription: truncate(payload.projectDescription || payload.description || '', 500),
    assistantResponse: truncate(payload.assistantResponse || payload.response || '', 1400),
    attachmentNames: normalizeAttachmentNames(payload.attachmentNames || payload.attachments),
    attachmentSummaries: normalizeAttachmentSummaries(
      payload.attachmentSummaries || payload.attachmentContext || payload.fileTriage,
    ),
  };
}

function buildFallbackName(input) {
  const { attachmentNames, userPrompt, projectDescription, assistantResponse } = normalizeNamingInput(input);

  // 1. Try attachment-derived name (most specific signal)
  const attachmentStem = attachmentNames
    .map((name) => deriveAttachmentStem(name))
    .find((name) => Boolean(toKebabCase(name)));
  if (attachmentStem) {
    return validateName(attachmentStem);
  }

  // 2. Try user prompt with filler stripped
  const cleanedPrompt = stripFillerFromPrompt(userPrompt);
  if (cleanedPrompt) {
    return validateName(cleanedPrompt);
  }

  // 3. Try project description with filler stripped
  const cleanedDescription = stripFillerFromPrompt(projectDescription);
  if (cleanedDescription) {
    return validateName(cleanedDescription);
  }

  // 4. Try extracting the subject from the assistant response
  // (often starts with "I'll create a X" or "Here's a Y")
  if (assistantResponse) {
    const cleanedResponse = stripFillerFromPrompt(assistantResponse);
    if (cleanedResponse) {
      return validateName(cleanedResponse);
    }
  }

  // 5. Last resort: raw prompt/description (pre-strip)
  return validateName(userPrompt || projectDescription || '');
}

export { stripFillerFromPrompt };

export function isPlaceholderProjectName(name) {
  return toKebabCase(name) === AUTO_PROJECT_PLACEHOLDER;
}

export function buildProjectNamingPrompt(input) {
  const context = normalizeNamingInput(input);
  const sections = [
    'Generate a short project slug for a software project.',
    'Return ONLY the slug in lowercase kebab-case. No explanation.',
    'Use 2 to 3 words maximum. Shorter is better.',
    'Focus on the core domain noun, not adjectives or verbs.',
    'Do not use generic words like build, app, project, starter, prototype, tool, platform, system, website, or site.',
  ];

  if (context.userPrompt) {
    sections.push(`Original user request:\n${context.userPrompt}`);
  }

  if (context.attachmentNames.length > 0) {
    sections.push(`Attached file names:\n- ${context.attachmentNames.join('\n- ')}`);
  }

  if (context.attachmentSummaries.length > 0) {
    sections.push(`Attachment triage:\n- ${context.attachmentSummaries.join('\n- ')}`);
  }

  if (context.projectDescription && context.projectDescription !== context.userPrompt) {
    sections.push(`Saved project description:\n${context.projectDescription}`);
  }

  if (context.assistantResponse) {
    sections.push(`First assistant response:\n${context.assistantResponse}`);
  }

  return sections.join('\n\n');
}

/**
 * Generate a concise project name from first-turn context.
 * @param {string|{userPrompt?: string, projectDescription?: string, assistantResponse?: string, attachmentNames?: Array<string|object>, attachmentSummaries?: string[]}} input
 * @returns {Promise<string|null>}
 */
/**
 * Build provider-specific request options for a naming completion.
 * Returns { url, headers, body } or null if the provider type is unsupported.
 */
function buildProviderRequest(providerType, apiKey, authType, model, prompt) {
  const content = prompt;

  if (providerType === 'anthropic') {
    const authHeaders = authType === 'oauth'
      ? { Authorization: `Bearer ${apiKey}` }
      : { 'x-api-key': apiKey };
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        'anthropic-version': '2023-06-01',
      },
      body: { model, max_tokens: 24, messages: [{ role: 'user', content }] },
      extractText: (data) => data?.content?.[0]?.text?.trim(),
    };
  }

  if (providerType === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: { model, max_tokens: 24, messages: [{ role: 'user', content }] },
      extractText: (data) => data?.choices?.[0]?.message?.content?.trim(),
    };
  }

  if (providerType === 'google') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    return {
      url,
      headers: { 'Content-Type': 'application/json' },
      body: {
        contents: [{ parts: [{ text: content }] }],
        generationConfig: { maxOutputTokens: 24 },
      },
      extractText: (data) => data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim(),
    };
  }

  return null;
}

/**
 * Generate a name via Claude CLI (for CLI-based providers like Claude Code).
 * Uses `claude --print --model haiku` for a fast one-shot completion.
 */
async function generateNameViaCLI(prompt) {
  try {
    const { binary, args: baseArgs } = await findClaudeBinary();
    const args = [
      ...baseArgs,
      '--print',
      '--model', 'haiku',
      '--max-turns', '1',
      '--',
      prompt,
    ];

    console.log(`[projectNaming] Calling Claude CLI (haiku) for name generation`);

    return new Promise((resolve) => {
      const child = execFile(binary, args, { timeout: TIMEOUT_MS }, (err, stdout) => {
        if (err) {
          console.log('[projectNaming] CLI call failed:', err.message);
          resolve(null);
          return;
        }
        resolve(stdout.trim() || null);
      });
      // Ensure we don't hang
      child.stdin?.end();
    });
  } catch (err) {
    console.log('[projectNaming] CLI binary not found:', err.message);
    return null;
  }
}

export async function generateProjectName(input) {
  const normalized = normalizeNamingInput(input);
  if (
    !normalized.userPrompt
    && !normalized.projectDescription
    && !normalized.assistantResponse
    && normalized.attachmentNames.length === 0
    && normalized.attachmentSummaries.length === 0
  ) {
    return null;
  }

  const fallbackName = buildFallbackName(normalized);
  const namingPrompt = buildProjectNamingPrompt(normalized);

  try {
    let providerType = null;
    let apiKey = null;
    let authType = 'api_key';
    let usesCLI = false;

    try {
      const providerData = await providerService.getActiveProviderWithKey();
      if (providerData?.apiKey && providerData?.provider?.type) {
        providerType = providerData.provider.type;
        apiKey = providerData.apiKey;
        authType = providerData.authType || 'api_key';
      }
      // Check if the active provider is CLI-based (no API key but has CLI)
      if (!apiKey && providerData?.useClaudeCLI) {
        usesCLI = true;
      }
    } catch {
      // Ignore provider resolution failures.
    }

    // Check if active provider is CLI-based even without providerData
    if (!apiKey && !usesCLI) {
      try {
        const providers = await providerService.getProviders();
        const active = providers?.find((p) => p.isActive);
        if (active?.type === 'anthropic' && (active._useClaudeCLI || active._credentialSource === 'claude_cli')) {
          usesCLI = true;
        }
      } catch {
        // Ignore
      }
    }

    // Env var fallback for Anthropic
    if (!apiKey && !usesCLI && process.env.ANTHROPIC_API_KEY) {
      providerType = 'anthropic';
      apiKey = process.env.ANTHROPIC_API_KEY;
      authType = 'api_key';
    }

    // Try Claude CLI for CLI-based providers
    if (!apiKey && usesCLI) {
      const cliResult = await generateNameViaCLI(namingPrompt);
      if (cliResult) {
        return validateName(cliResult) || fallbackName;
      }
      return fallbackName;
    }

    if (!apiKey || !providerType) {
      console.log('[projectNaming] No API key or CLI available, using fallback name:', fallbackName);
      return fallbackName;
    }

    // Use the triage model for the active provider (cheapest/fastest)
    const model = providerService.getSmartReviewModel(providerType, 'triage');
    if (!model) {
      console.log(`[projectNaming] No triage model for provider ${providerType}, using fallback:`, fallbackName);
      return fallbackName;
    }

    const req = buildProviderRequest(providerType, apiKey, authType, model, namingPrompt);
    if (!req) {
      console.log(`[projectNaming] Unsupported provider type ${providerType}, using fallback:`, fallbackName);
      return fallbackName;
    }

    console.log(`[projectNaming] Calling ${providerType} (${model}) for name generation`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.log(`[projectNaming] API returned ${response.status}, using fallback. ${errText.slice(0, 200)}`);
        return fallbackName;
      }

      const data = await response.json();
      const raw = req.extractText(data);
      return validateName(raw) || fallbackName;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.log('[projectNaming] API call failed, using fallback name:', fallbackName, err?.message || '');
    return fallbackName;
  }
}

export function validateName(raw) {
  if (!raw) return null;

  let name = String(raw).replace(/^["']+|["']+$/g, '').trim();
  if (!name) return null;

  const words = name.split(/\s+/);
  if (words.length > MAX_WORDS) {
    name = words.slice(0, MAX_WORDS).join(' ');
  }

  name = toKebabCase(name);
  if (!name || name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH).replace(/-$/, '');
  }

  return name || null;
}
