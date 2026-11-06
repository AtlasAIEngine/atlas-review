import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const getDbTypeMock = vi.fn(() => 'postgres');

vi.mock('../../../db/connection.js', () => ({
  default: {
    query: (...args) => queryMock(...args),
  },
  getDbType: (...args) => getDbTypeMock(...args),
}));

import reviewAgentStore from '../reviewAgentStore.js';

describe('reviewAgentStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbTypeMock.mockReturnValue('postgres');
    queryMock.mockResolvedValue({ rows: [] });
  });

  it('persists sessions scoped by project, review type, and review id', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (String(sql).includes('RETURNING id, project_id')) {
        return {
          rows: [{
            id: 'session-1',
            project_id: 'project-1',
            user_id: 'user-1',
            review_type: 'pr_review',
            review_id: 'pr-1',
            provider_type: 'openai',
            provider_model: 'gpt-5.4',
            provider_session_id: null,
            title: 'Review',
            status: 'active',
            created_at: '2026-04-30T00:00:00.000Z',
            updated_at: '2026-04-30T00:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    });

    const session = await reviewAgentStore.createSession({
      sessionId: 'session-1',
      projectId: 'project-1',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
      userId: 'user-1',
      providerType: 'openai',
      providerModel: 'gpt-5.4',
      title: 'Review',
    });

    expect(session).toMatchObject({
      id: 'session-1',
      projectId: 'project-1',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
      providerType: 'openai',
      providerModel: 'gpt-5.4',
      status: 'active',
    });
    const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO review_agent_sessions'));
    expect(insertCall?.[1]).toEqual([
      'session-1',
      'project-1',
      'user-1',
      'pr_review',
      'pr-1',
      'openai',
      'gpt-5.4',
      'Review',
      'active',
    ]);
  });

  it('saves messages without touching builder chat tables', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (String(sql).includes('INSERT INTO review_agent_messages')) {
        return {
          rows: [{
            id: 'message-1',
            session_id: 'session-1',
            role: 'assistant',
            content: 'Review-only answer',
            tokens_used: 12,
            model: 'gpt-5.4',
            meta: { readOnly: true },
            created_at: '2026-04-30T00:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    });

    const message = await reviewAgentStore.saveMessage({
      messageId: 'message-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'Review-only answer',
      tokensUsed: 12,
      model: 'gpt-5.4',
      meta: { readOnly: true },
    });

    expect(message).toMatchObject({
      id: 'message-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: 'Review-only answer',
      meta: { readOnly: true },
    });
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('chat_messages'))).toBe(false);
  });

  it('merges action results into review-agent message metadata', async () => {
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('SELECT id, session_id, role, content, tokens_used, model, meta, created_at')) {
        return {
          rows: [{
            id: 'message-1',
            session_id: 'session-1',
            role: 'assistant',
            content: 'Action proposed',
            tokens_used: 0,
            model: null,
            meta: { actions: [{ type: 'run_review', mode: 'standard' }] },
            created_at: '2026-04-30T00:00:00.000Z',
          }],
        };
      }
      if (text.includes('UPDATE review_agent_messages')) {
        return {
          rows: [{
            id: 'message-1',
            session_id: 'session-1',
            role: 'assistant',
            content: 'Action proposed',
            tokens_used: 0,
            model: null,
            meta: {
              actions: [{ type: 'run_review', mode: 'standard' }],
              actionResults: {
                '0:run_review:standard': {
                  status: 'opened',
                  label: 'Review started',
                  at: '2026-04-30T00:00:00.000Z',
                },
              },
            },
            created_at: '2026-04-30T00:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    });

    const message = await reviewAgentStore.recordMessageActionResult(
      'session-1',
      'message-1',
      '0:run_review:standard',
      {
        status: 'opened',
        label: 'Review started',
        at: '2026-04-30T00:00:00.000Z',
      }
    );

    expect(message.meta.actionResults['0:run_review:standard']).toMatchObject({
      status: 'opened',
      label: 'Review started',
    });
    const updateCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE review_agent_messages'));
    expect(updateCall?.[1]?.[2]).toMatchObject({
      actions: [{ type: 'run_review', mode: 'standard' }],
      actionResults: {
        '0:run_review:standard': {
          status: 'opened',
          label: 'Review started',
          at: '2026-04-30T00:00:00.000Z',
        },
      },
    });
  });

  it('normalizes and validates review scope', () => {
    expect(reviewAgentStore.normalizeScope({
      projectId: ' project-1 ',
      reviewType: 'PR_REVIEW',
      reviewId: ' pr-1 ',
    })).toEqual({
      projectId: 'project-1',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
    });

    expect(() => reviewAgentStore.normalizeScope({
      projectId: 'project-1',
      reviewType: 'builder',
      reviewId: 'x',
    })).toThrow(/reviewType/);
  });
});
