import { describe, it, expect } from 'vitest';

import {
  filterRealPrCorpusEntries,
  rankRealPrCorpusEntries,
  summarizeRealPrCorpus,
} from '../reviewRealPrCorpus.js';

describe('reviewRealPrCorpus helpers', () => {
  const entries = [
    {
      id: 'reserve-large',
      selectionStatus: 'reserve',
      priority: 8,
      prNumber: 8805,
      tokenProfile: { sizeClass: 'large' },
    },
    {
      id: 'selected-medium',
      selectionStatus: 'selected',
      priority: 5,
      prNumber: 9173,
      tokenProfile: { sizeClass: 'medium' },
      title: 'FTUE tracing',
      bugClasses: ['unity.missing_unsubscribe'],
    },
    {
      id: 'selected-small',
      selectionStatus: 'selected',
      priority: 1,
      prNumber: 9179,
      tokenProfile: { sizeClass: 'small' },
      title: 'Asset validation fix',
      bugClasses: ['core.analytics'],
    },
  ];

  it('filters by selection status and max size class', () => {
    const filtered = filterRealPrCorpusEntries(entries, {
      selectionStatus: 'selected',
      maxSizeClass: 'medium',
    });

    expect(filtered.map((entry) => entry.id)).toEqual([
      'selected-medium',
      'selected-small',
    ]);
  });

  it('ranks selected entries before reserve and by priority', () => {
    const ranked = rankRealPrCorpusEntries(entries);

    expect(ranked.map((entry) => entry.id)).toEqual([
      'selected-small',
      'selected-medium',
      'reserve-large',
    ]);
  });

  it('builds a compact corpus summary', () => {
    const summary = summarizeRealPrCorpus(entries);

    expect(summary).toEqual({
      totalEntries: 3,
      selectedCount: 2,
      reserveCount: 1,
      selectedPrNumbers: [9179, 9173],
      reservePrNumbers: [8805],
      bugClassCounts: {
        'core.analytics': 1,
        'unity.missing_unsubscribe': 1,
      },
      highestPriority: {
        id: 'selected-small',
        prNumber: 9179,
        title: 'Asset validation fix',
      },
    });
  });
});
