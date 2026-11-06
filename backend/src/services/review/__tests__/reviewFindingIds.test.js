import { describe, expect, it } from 'vitest';
import { assignReviewFindingIds } from '../reviewFindingIds.js';

describe('review finding ids', () => {
  it('assigns short sequential ids to recommendations and previous findings', () => {
    const review = assignReviewFindingIds({
      recommendations: [
        { recommendationKey: 'key-a', title: 'A' },
        { recommendationKey: 'key-b', title: 'B' },
      ],
      previousFindings: [
        { recommendationKey: 'key-c', title: 'C' },
      ],
    });

    expect(review.recommendations.map((rec) => rec.findingId)).toEqual(['F1', 'F2']);
    expect(review.previousFindings.map((rec) => rec.findingId)).toEqual(['F3']);
  });

  it('preserves existing and prior ids when recommendation keys match', () => {
    const review = assignReviewFindingIds({
      recommendations: [
        { recommendationKey: 'key-a', title: 'A' },
        { recommendationKey: 'key-b', findingId: 'F9', title: 'B' },
      ],
    }, {
      previousReview: {
        recommendations: [
          { recommendationKey: 'key-a', findingId: 'F4', title: 'Previous A' },
        ],
      },
    });

    expect(review.recommendations.map((rec) => rec.findingId)).toEqual(['F4', 'F9']);
  });

  it('allocates a new id when a preserved id would collide', () => {
    const review = assignReviewFindingIds({
      recommendations: [
        { recommendationKey: 'key-a', findingId: 'F1', title: 'A' },
        { recommendationKey: 'key-b', title: 'B' },
      ],
    }, {
      previousReview: {
        recommendations: [
          { recommendationKey: 'key-b', findingId: 'F1', title: 'Previous B' },
        ],
      },
    });

    expect(review.recommendations.map((rec) => rec.findingId)).toEqual(['F1', 'F2']);
  });

  it('allocates a new id when duplicate existing ids collide', () => {
    const review = assignReviewFindingIds({
      recommendations: [
        { recommendationKey: 'key-a', findingId: 'F1', title: 'A' },
        { recommendationKey: 'key-b', findingId: 'F1', title: 'B' },
      ],
      previousFindings: [
        { recommendationKey: 'key-c', findingId: 'F2', title: 'C' },
        { recommendationKey: 'key-d', findingId: 'F2', title: 'D' },
      ],
    });

    expect(review.recommendations.map((rec) => rec.findingId)).toEqual(['F1', 'F2']);
    expect(review.previousFindings.map((rec) => rec.findingId)).toEqual(['F3', 'F4']);
  });
});
