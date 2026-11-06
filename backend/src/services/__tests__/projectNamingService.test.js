import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../providerService.js', () => ({
  default: {
    getActiveProviderWithKey: vi.fn(),
    getSmartReviewModel: vi.fn().mockReturnValue('claude-haiku-4-5-20251001'),
    getProviders: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../utils/claudeBinary.js', () => ({
  findClaudeBinary: vi.fn().mockRejectedValue(new Error('not found')),
}));

import providerService from '../providerService.js';
import {
  AUTO_PROJECT_PLACEHOLDER,
  buildProjectNamingPrompt,
  generateProjectName,
  isPlaceholderProjectName,
  stripFillerFromPrompt,
  validateName,
} from '../projectNamingService.js';

describe('projectNamingService', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalAnthropicKey) {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    vi.unstubAllGlobals();
  });

  it('recognizes the placeholder project name', () => {
    expect(AUTO_PROJECT_PLACEHOLDER).toBe('untitled-project');
    expect(isPlaceholderProjectName('untitled-project')).toBe(true);
    expect(isPlaceholderProjectName('Untitled Project')).toBe(true);
    expect(isPlaceholderProjectName('customer-portal')).toBe(false);
  });

  it('builds a naming prompt from first-turn context', () => {
    const prompt = buildProjectNamingPrompt({
      userPrompt: 'lets build this',
      projectDescription: 'lets build this',
      assistantResponse: 'I will create a Jira-style task manager with boards and issue detail views.',
      attachmentNames: ['MiniJira-Spec.md'],
      attachmentSummaries: ['MiniJira-Spec.md: A lightweight Jira clone with boards, sprints, backlog, and issue detail pages.'],
    });

    expect(prompt).toContain('Original user request');
    expect(prompt).toContain('MiniJira-Spec.md');
    expect(prompt).toContain('Attachment triage');
    expect(prompt).toContain('backlog');
    expect(prompt).toContain('First assistant response');
    expect(prompt).toContain('kebab-case');
  });

  it('falls back to attachment-derived naming when no naming API is available', async () => {
    providerService.getActiveProviderWithKey.mockResolvedValue(null);

    const name = await generateProjectName({
      userPrompt: 'lets build this',
      attachmentNames: ['MiniJira-Spec.md'],
      assistantResponse: 'I will build a task tracker.',
    });

    expect(name).toBe('minijira');
  });

  it('normalizes AI output into a slug (Anthropic)', async () => {
    providerService.getActiveProviderWithKey.mockResolvedValue({
      apiKey: 'test-key',
      authType: 'api_key',
      provider: { type: 'anthropic' },
    });
    providerService.getSmartReviewModel.mockReturnValue('claude-haiku-4-5-20251001');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ text: 'Mini Jira Workspace' }],
      }),
    }));

    const name = await generateProjectName({
      userPrompt: 'build a jira planning tool',
      assistantResponse: 'I will create boards, sprints, and issue workflows.',
      attachmentNames: ['MiniJira-Spec.md'],
    });

    expect(name).toBe('mini-jira-workspace');
  });

  it('works with OpenAI provider', async () => {
    providerService.getActiveProviderWithKey.mockResolvedValue({
      apiKey: 'sk-test',
      authType: 'api_key',
      provider: { type: 'openai' },
    });
    providerService.getSmartReviewModel.mockReturnValue('gpt-5.4-nano');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'marketing-website' } }],
      }),
    }));

    const name = await generateProjectName({
      userPrompt: 'I want to build a website for my marketing company',
    });

    expect(name).toBe('marketing-website');
    const fetchCall = fetch.mock.calls[0];
    expect(fetchCall[0]).toContain('openai.com');
    expect(JSON.parse(fetchCall[1].body).model).toBe('gpt-5.4-nano');
  });

  it('works with Google provider', async () => {
    providerService.getActiveProviderWithKey.mockResolvedValue({
      apiKey: 'goog-test',
      authType: 'api_key',
      provider: { type: 'google' },
    });
    providerService.getSmartReviewModel.mockReturnValue('gemini-3.1-flash-lite-preview');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'crypto-dashboard' }] } }],
      }),
    }));

    const name = await generateProjectName({
      userPrompt: 'make me a dashboard for tracking crypto prices',
    });

    expect(name).toBe('crypto-dashboard');
    const fetchCall = fetch.mock.calls[0];
    expect(fetchCall[0]).toContain('generativelanguage.googleapis.com');
    expect(fetchCall[0]).toContain('gemini-3.1-flash-lite-preview');
  });

  it('validates names into bounded kebab-case', () => {
    expect(validateName('"Customer Portal PRD"')).toBe('customer-portal-prd');
  });

  describe('stripFillerFromPrompt', () => {
    it('strips leading filler phrases', () => {
      expect(stripFillerFromPrompt('Build me a todo app')).toBe('todo');
      expect(stripFillerFromPrompt("Let's build a recipe manager")).toBe('recipe manager');
      expect(stripFillerFromPrompt('Can you please create a dashboard')).toBe('dashboard');
      expect(stripFillerFromPrompt('I want to build a chat application')).toBe('chat');
      expect(stripFillerFromPrompt('Please help me create an e-commerce site')).toBe('e commerce');
    });

    it('strips filler words (articles, adjectives, action verbs)', () => {
      expect(stripFillerFromPrompt('a simple todo app with some nice features')).toBe('todo features');
      expect(stripFillerFromPrompt('the great new dashboard')).toBe('dashboard');
      expect(stripFillerFromPrompt('build and design a portfolio')).toBe('portfolio');
    });

    it('handles already clean input', () => {
      expect(stripFillerFromPrompt('todo app')).toBe('todo');
      expect(stripFillerFromPrompt('recipe-manager')).toBe('recipe manager');
      expect(stripFillerFromPrompt('kanban board')).toBe('kanban board');
    });

    it('handles empty/null input', () => {
      expect(stripFillerFromPrompt('')).toBe('');
      expect(stripFillerFromPrompt(null)).toBe('');
      expect(stripFillerFromPrompt(undefined)).toBe('');
    });

    it('handles nested filler phrases', () => {
      expect(stripFillerFromPrompt('Please can you build me a kanban board')).toBe('kanban board');
    });
  });

  describe('fallback naming with filler stripping', () => {
    beforeEach(() => {
      providerService.getActiveProviderWithKey.mockResolvedValue(null);
    });

    it('strips filler from user prompt for fallback name', async () => {
      const name = await generateProjectName({
        userPrompt: 'Build me a todo app with authentication and dark mode',
      });
      // "app/with" stripped as filler, MAX_WORDS=4: "todo authentication dark mode"
      expect(name).toBe('todo-authentication-dark-mode');
    });

    it('strips filler from "lets create" style prompts', async () => {
      const name = await generateProjectName({
        userPrompt: "Let's create a recipe sharing platform",
      });
      expect(name).toBe('recipe-sharing');
    });

    it('strips filler from "I want to" style prompts', async () => {
      const name = await generateProjectName({
        userPrompt: 'I want to build a real-time chat application',
      });
      expect(name).toBe('real-time-chat');
    });

    it('falls through to assistant response when prompt is all filler', async () => {
      const name = await generateProjectName({
        userPrompt: 'please help me build this',
        assistantResponse: 'I will create a kanban board with drag and drop',
      });
      expect(name).toBe('kanban-board-drag-drop');
    });

    it('produces short names for long prompts', async () => {
      const name = await generateProjectName({
        userPrompt: 'I am going to build a website for a marketing agency with modern responsive design',
      });
      // "I am going to" phrase stripped, "build/a/for/with/modern/responsive" filler words stripped
      // remaining meaningful: "website marketing agency" → MAX_WORDS=4 keeps all 3
      expect(name).toBe('marketing-agency');
    });

    it('prefers attachment name over filler-heavy prompt', async () => {
      const name = await generateProjectName({
        userPrompt: 'can you please build this for me',
        attachmentNames: ['expense-tracker-spec.pdf'],
      });
      expect(name).toBe('expense-tracker');
    });
  });
});
