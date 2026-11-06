import { expect, test } from '@playwright/test';

import { getInlineCommentAnchorLine } from '../InlineComments';

test.describe('getInlineCommentAnchorLine', () => {
  test('anchors AI findings only to right-side diff lines', () => {
    expect(getInlineCommentAnchorLine({ newNum: 23 })).toBe(23);
    expect(getInlineCommentAnchorLine({ newNum: null })).toBeNull();
  });
});
