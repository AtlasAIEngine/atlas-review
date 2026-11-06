import { test, expect } from '@playwright/test';
import {
  getReviewAgentActionKey,
  getReviewAgentAttachmentLabel,
  isSameReviewAgentScope,
} from '../reviewAgentDrawerUtils';

test.describe('ReviewAgentDrawer helpers', () => {
  test('matches socket payloads only inside the active review scope', () => {
    const scope = { projectId: 'project-1', reviewType: 'pr_review' as const, reviewId: 'pr-1' };

    expect(isSameReviewAgentScope(scope, { ...scope })).toBe(true);
    expect(isSameReviewAgentScope(scope, { ...scope, reviewId: 'pr-2' })).toBe(false);
    expect(isSameReviewAgentScope(scope, { ...scope, reviewType: 'branch_review' })).toBe(false);
  });

  test('labels selected finding and file context pills', () => {
    expect(getReviewAgentAttachmentLabel({ type: 'finding', recommendationKey: 'issue|high|camera-null' }))
      .toBe('Finding issue|high|camera-null');
    expect(getReviewAgentAttachmentLabel({ type: 'file', path: 'src/App.tsx' }))
      .toBe('src/App.tsx');
    expect(getReviewAgentAttachmentLabel({ type: 'line_range', path: 'src/App.tsx', startLine: 4, endLine: 8 }))
      .toBe('src/App.tsx:4-8');
    expect(getReviewAgentAttachmentLabel({ type: 'github_thread', threadNodeId: 'THREAD_node_id_1234567890' }))
      .toBe('GitHub thread THREAD_node_id_1234567890');
    expect(getReviewAgentAttachmentLabel({ type: 'github_issue_comment', commentNodeId: 'COMMENT_node_id_1234567890' }))
      .toBe('GitHub comment COMMENT_node_id_1234567890');
  });

  test('builds stable action result keys', () => {
    expect(getReviewAgentActionKey({ type: 'run_review', mode: 'standard' }, 0))
      .toBe('0:run_review:gvtd8b');
    expect(getReviewAgentActionKey({ type: 'fix_findings', recommendationKeys: ['issue|high|one'] }, 1))
      .toBe('1:fix_findings:1lvnh39');
    expect(getReviewAgentActionKey({ type: 'publish_pr_review', action: 'request_changes', recommendationKeys: ['issue|high|one'] }, 2))
      .toBe('2:publish_pr_review:iih2ut');
  });
});
