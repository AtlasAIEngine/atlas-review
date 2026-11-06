import { describe, expect, it } from 'vitest';
import { inferReviewAgentActionsFromRequest, parseReviewAgentActions } from '../reviewAgentActionParser.js';

describe('reviewAgentActionParser', () => {
  it('extracts draft PR replies for attached GitHub threads and strips action blocks', () => {
    const result = parseReviewAgentActions(
      [
        'Here is a draft.',
        '',
        '```atlas-review-agent-action',
        '{"type":"draft_pr_reply","threadNodeId":"thread-1","body":"Thanks, I will update this."}',
        '```',
      ].join('\n'),
      {
        attachments: [
          { type: 'github_thread', threadNodeId: 'thread-1' },
        ],
      }
    );

    expect(result.content).toBe('Here is a draft.');
    expect(result.actions).toEqual([
      {
        type: 'draft_pr_reply',
        threadNodeId: 'thread-1',
        body: 'Thanks, I will update this.',
      },
    ]);
  });

  it('rejects draft PR replies for unscoped GitHub threads', () => {
    const result = parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"draft_pr_reply","threadNodeId":"thread-2","body":"Post me"}\n```',
      {
        attachments: [
          { type: 'github_thread', threadNodeId: 'thread-1' },
        ],
      }
    );

    expect(result.actions).toEqual([]);
    expect(parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"draft_pr_reply","threadNodeId":"thread-2","body":"Post me"}\n```',
      { attachments: [] }
    ).actions).toEqual([]);
  });

  it('extracts fix finding actions only for attached findings', () => {
    const result = parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"fix_findings","recommendationKeys":["ISSUE|HIGH|ONE","issue|high|two"]}\n```',
      {
        attachments: [
          { type: 'finding', recommendationKey: 'issue|high|one' },
        ],
      }
    );

    expect(result.actions).toEqual([
      {
        type: 'fix_findings',
        recommendationKeys: ['issue|high|one'],
      },
    ]);

    expect(parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"fix_findings","recommendationKeys":["issue|high|one"]}\n```',
      { attachments: [] }
    ).actions).toEqual([]);
  });

  it('resolves displayed finding IDs to recommendation keys for fix actions', () => {
    const result = parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"fix_findings","findingIds":["F1"]}\n```',
      {
        findingRefs: [
          { findingId: 'F1', recommendationKey: 'issue|high|one' },
        ],
      }
    );

    expect(result.actions).toEqual([
      {
        type: 'fix_findings',
        recommendationKeys: ['issue|high|one'],
      },
    ]);
  });

  it('extracts bare escaped action JSON and removes it from display content', () => {
    const result = parseReviewAgentActions(
      '{\\"type\\":\\"fix_findings\\",\\"findingIds\\":[\\"F1\\"]}',
      {
        findingRefs: [
          { findingId: 'F1', recommendationKey: 'issue|high|one' },
        ],
      }
    );

    expect(result.content).toBe('');
    expect(result.actions).toEqual([
      {
        type: 'fix_findings',
        recommendationKeys: ['issue|high|one'],
      },
    ]);
  });

  it('extracts action JSON from generic code fences without rendering the raw JSON', () => {
    const result = parseReviewAgentActions(
      '```json\n{\\"type\\":\\"fix_findings\\",\\"findingIds\\":[\\"F1\\"]}\n```',
      {
        findingRefs: [
          { findingId: 'F1', recommendationKey: 'issue|high|one' },
        ],
      }
    );

    expect(result.content).toBe('');
    expect(result.actions).toEqual([
      {
        type: 'fix_findings',
        recommendationKeys: ['issue|high|one'],
      },
    ]);
  });

  it('hides action-shaped JSON even when scope rejects the action', () => {
    const result = parseReviewAgentActions(
      '{\\"type\\":\\"fix_findings\\",\\"recommendationKeys\\":[\\"issue|high|one\\"]}',
      { attachments: [] }
    );

    expect(result.content).toBe('');
    expect(result.actions).toEqual([]);
    expect(result.strippedActionPayload).toBe(true);
  });

  it('loosely matches model-emitted recommendation keys to current findings', () => {
    const result = parseReviewAgentActions(
      '{\\"type\\":\\"fix_findings\\",\\"recommendationKeys\\":[\\"issue|high|quote drift|normalize this key with spaced text|backend/src/file.js|41|if (!allowed.has(key)) return null;\\"]}',
      {
        findingRefs: [
          {
            findingId: 'F1',
            recommendationKey: 'issue|high|quote drift|`normalize this key` with spaced text|backend/src/file.js|41|if (!allowed.has(key)) return null;',
          },
        ],
      }
    );

    expect(result.content).toBe('');
    expect(result.actions).toEqual([
      {
        type: 'fix_findings',
        recommendationKeys: [
          'issue|high|quote drift|`normalize this key` with spaced text|backend/src/file.js|41|if (!allowed.has(key)) return null;',
        ],
      },
    ]);
  });

  it('extracts run review actions with a constrained mode', () => {
    const result = parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"run_review","mode":"full"}\n```',
      { scope: { reviewType: 'pr_review', reviewId: 'pr-1' } }
    );

    expect(result.actions).toEqual([
      {
        type: 'run_review',
        mode: 'full',
      },
    ]);
  });

  it('extracts outcome actions only for attached findings', () => {
    const result = parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"set_outcome","recommendationKey":"ISSUE|HIGH|ONE","status":"dismissed","note":"Covered by existing guard."}\n```',
      {
        attachments: [
          { type: 'finding', recommendationKey: 'issue|high|one' },
        ],
      }
    );

    expect(result.actions).toEqual([
      {
        type: 'set_outcome',
        recommendationKey: 'issue|high|one',
        status: 'dismissed',
        note: 'Covered by existing guard.',
      },
    ]);

    expect(parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"set_outcome","recommendationKey":"issue|high|one","status":"dismissed"}\n```',
      { attachments: [] }
    ).actions).toEqual([]);
  });

  it('resolves displayed finding IDs to recommendation keys for outcome actions', () => {
    const result = parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"set_outcome","findingId":"F2","status":"dismissed"}\n```',
      {
        findingRefs: [
          { findingId: 'F2', recommendationKey: 'issue|medium|two' },
        ],
      }
    );

    expect(result.actions).toEqual([
      {
        type: 'set_outcome',
        recommendationKey: 'issue|medium|two',
        status: 'dismissed',
      },
    ]);
  });

  it('extracts PR review publish actions only for PR review scopes', () => {
    const result = parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"publish_pr_review","action":"request_changes","body":"Please address this.","recommendationKeys":["issue|high|one"]}\n```',
      {
        scope: { reviewType: 'pr_review', reviewId: 'pr-1' },
        attachments: [
          { type: 'finding', recommendationKey: 'issue|high|one' },
        ],
      }
    );

    expect(result.actions).toEqual([
      {
        type: 'publish_pr_review',
        action: 'request_changes',
        body: 'Please address this.',
        recommendationKeys: ['issue|high|one'],
      },
    ]);

    expect(parseReviewAgentActions(
      '```atlas-review-agent-action\n{"type":"publish_pr_review","action":"approve"}\n```',
      { scope: { reviewType: 'branch_review', reviewId: 'br-1' } }
    ).actions).toEqual([]);
  });

  it('infers fix action from an explicit user request for a visible finding ID', () => {
    const actions = inferReviewAgentActionsFromRequest(
      'Can you check and fix F1 issue?',
      {
        findingRefs: [
          { findingId: 'F1', recommendationKey: 'issue|medium|sqlite migration' },
          { findingId: 'F2', recommendationKey: 'issue|low|test runner' },
        ],
      }
    );

    expect(actions).toEqual([
      {
        type: 'fix_findings',
        recommendationKeys: ['issue|medium|sqlite migration'],
      },
    ]);
  });

  it('infers fix action for an attached finding when the request says fix this issue', () => {
    const actions = inferReviewAgentActionsFromRequest(
      'Please fix this issue',
      {
        attachments: [
          { type: 'finding', recommendationKey: 'issue|high|attached' },
        ],
      }
    );

    expect(actions).toEqual([
      {
        type: 'fix_findings',
        recommendationKeys: ['issue|high|attached'],
      },
    ]);
  });

  it('does not infer fix action for explain-only requests', () => {
    expect(inferReviewAgentActionsFromRequest(
      'Can you explain F1?',
      {
        findingRefs: [
          { findingId: 'F1', recommendationKey: 'issue|medium|sqlite migration' },
        ],
      }
    )).toEqual([]);
  });
});
