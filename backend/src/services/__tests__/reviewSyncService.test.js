import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const getDbTypeMock = vi.fn();

vi.mock('../../db/connection.js', () => ({
  default: { query: queryMock },
  getDbType: getDbTypeMock,
}));

const reviewSyncModule = await import('../reviewSyncService.js');
const {
  queueEvent,
  ingestEvents,
  getStats,
  getLocalSyncStatus,
  flushPendingEvents,
  buildReviewCompletedEvent,
} = reviewSyncModule;
const { __testing } = reviewSyncModule.default;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  getDbTypeMock.mockReturnValue('sqlite');
  delete process.env.ATLAS_DESKTOP_MODE;
  delete process.env.ATLAS_REVIEW_SYNC_USER_ID;
  delete process.env.ATLAS_REVIEW_SYNC_DEVICE_ID;
  delete process.env.ATLAS_REVIEW_SYNC_AUTH_TOKEN;
  delete process.env.ATLAS_REVIEW_SYNC_SERVER_URL;
  __testing.resetSyncSchemaRepairState();
});

describe('reviewSyncService', () => {
  it('queues desktop events as pending by default', async () => {
    process.env.ATLAS_DESKTOP_MODE = 'true';
    queryMock.mockResolvedValue({
      rows: [{
        id: 'evt-1',
        user_id: 'user-1',
        device_id: null,
        event_type: 'review_completed',
        sync_status: 'pending',
        sync_error: null,
        sync_attempt_count: 0,
        synced_at: null,
        project_id: 'proj-1',
        project_name: 'Atlas',
        project_path: '/tmp/atlas',
        review_type: 'branch_review',
        review_id: 'br-1',
        recommendation_key: null,
        event_idempotency_key: 'key-1',
        occurred_at: '2026-03-16T10:00:00.000Z',
        payload_json: JSON.stringify({ issuesFound: 2 }),
        created_at: '2026-03-16T10:00:00.000Z',
        updated_at: '2026-03-16T10:00:00.000Z',
      }],
      rowCount: 1,
    });

    const event = await queueEvent({
      userId: 'user-1',
      eventType: 'review_completed',
      projectId: 'proj-1',
      projectName: 'Atlas',
      projectPath: '/tmp/atlas',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      occurredAt: '2026-03-16T10:00:00.000Z',
      payload: { issuesFound: 2 },
    });

    expect(event?.syncStatus).toBe('pending');
    const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO review_sync_events'));
    expect(insertCall?.[0]).toContain('INSERT INTO review_sync_events');
    expect(insertCall?.[1]?.[4]).toBe('pending');
  });

  it('ingests remote events as synced records', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        id: 'evt-2',
        user_id: 'user-1',
        device_id: 'device-1',
        event_type: 'finding_addressed',
        sync_status: 'synced',
        sync_error: null,
        sync_attempt_count: 0,
        synced_at: '2026-03-16T10:05:00.000Z',
        project_id: 'proj-1',
        project_name: null,
        project_path: null,
        review_type: 'branch_review',
        review_id: 'br-1',
        recommendation_key: 'rec-1',
        event_idempotency_key: 'key-2',
        occurred_at: '2026-03-16T10:04:00.000Z',
        payload_json: JSON.stringify({ status: 'addressed' }),
        created_at: '2026-03-16T10:05:00.000Z',
        updated_at: '2026-03-16T10:05:00.000Z',
      }],
      rowCount: 1,
    });

    const events = await ingestEvents({
      userId: 'user-1',
      deviceId: 'device-1',
      events: [{
        eventType: 'finding_addressed',
        projectId: 'proj-1',
        reviewType: 'branch_review',
        reviewId: 'br-1',
        recommendationKey: 'rec-1',
        occurredAt: '2026-03-16T10:04:00.000Z',
        payload: { status: 'addressed' },
      }],
    });

    expect(events).toHaveLength(1);
    const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO review_sync_events'));
    expect(insertCall?.[1]?.[4]).toBe('synced');
    expect(insertCall?.[1]?.[2]).toBe('device-1');
  });

  it('aggregates review stats from the latest finding state', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          id: 'evt-review',
          user_id: 'user-1',
          device_id: null,
          event_type: 'review_completed',
          sync_status: 'synced',
          sync_error: null,
          sync_attempt_count: 0,
          synced_at: '2026-03-16T10:00:05.000Z',
          project_id: 'proj-1',
          project_name: 'Atlas',
          project_path: '/tmp/atlas',
          review_type: 'branch_review',
          review_id: 'br-1',
          recommendation_key: null,
          event_idempotency_key: 'review-key',
          occurred_at: '2026-03-16T10:00:00.000Z',
          payload_json: JSON.stringify({ issuesFound: 3, highRiskFindings: 1 }),
          created_at: '2026-03-16T10:00:00.000Z',
          updated_at: '2026-03-16T10:00:00.000Z',
        },
        {
          id: 'evt-addressed',
          user_id: 'user-1',
          device_id: null,
          event_type: 'finding_addressed',
          sync_status: 'synced',
          sync_error: null,
          sync_attempt_count: 0,
          synced_at: '2026-03-16T10:01:05.000Z',
          project_id: 'proj-1',
          project_name: 'Atlas',
          project_path: '/tmp/atlas',
          review_type: 'branch_review',
          review_id: 'br-1',
          recommendation_key: 'rec-1',
          event_idempotency_key: 'rec-1-addressed',
          occurred_at: '2026-03-16T10:01:00.000Z',
          payload_json: JSON.stringify({ status: 'addressed' }),
          created_at: '2026-03-16T10:01:00.000Z',
          updated_at: '2026-03-16T10:01:00.000Z',
        },
        {
          id: 'evt-dismissed',
          user_id: 'user-1',
          device_id: null,
          event_type: 'finding_dismissed',
          sync_status: 'synced',
          sync_error: null,
          sync_attempt_count: 0,
          synced_at: '2026-03-16T10:02:05.000Z',
          project_id: 'proj-1',
          project_name: 'Atlas',
          project_path: '/tmp/atlas',
          review_type: 'branch_review',
          review_id: 'br-1',
          recommendation_key: 'rec-2',
          event_idempotency_key: 'rec-2-dismissed',
          occurred_at: '2026-03-16T10:02:00.000Z',
          payload_json: JSON.stringify({ status: 'dismissed' }),
          created_at: '2026-03-16T10:02:00.000Z',
          updated_at: '2026-03-16T10:02:00.000Z',
        },
        {
          id: 'evt-cleared',
          user_id: 'user-1',
          device_id: null,
          event_type: 'finding_cleared',
          sync_status: 'synced',
          sync_error: null,
          sync_attempt_count: 0,
          synced_at: '2026-03-16T10:03:05.000Z',
          project_id: 'proj-1',
          project_name: 'Atlas',
          project_path: '/tmp/atlas',
          review_type: 'branch_review',
          review_id: 'br-1',
          recommendation_key: 'rec-1',
          event_idempotency_key: 'rec-1-cleared',
          occurred_at: '2026-03-16T10:03:00.000Z',
          payload_json: JSON.stringify({}),
          created_at: '2026-03-16T10:03:00.000Z',
          updated_at: '2026-03-16T10:03:00.000Z',
        },
      ],
      rowCount: 4,
    });

    const stats = await getStats('user-1');

    expect(stats).toEqual(expect.objectContaining({
      reviewsCompleted: 1,
      issuesFound: 3,
      highRiskFindings: 1,
      findingsAddressed: 0,
      findingsDismissed: 1,
      totalResolvedFindings: 1,
      fixRate: 0,
      resolutionRate: 0.3333,
      totalEvents: 4,
    }));
  });

  it('falls back to operator-configured desktop user and device identifiers', () => {
    process.env.ATLAS_REVIEW_SYNC_USER_ID = 'operator-user';
    process.env.ATLAS_REVIEW_SYNC_DEVICE_ID = 'desktop-macbook';

    const normalized = __testing.normalizeQueueInput(buildReviewCompletedEvent({
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      completedAt: '2026-03-16T10:00:00.000Z',
      issuesFound: 2,
    }));

    expect(normalized.userId).toBe('operator-user');
    expect(normalized.deviceId).toBe('desktop-macbook');
  });

  it('rewrites anonymous review events onto the active desktop guest user', () => {
    process.env.ATLAS_REVIEW_SYNC_USER_ID = 'guest-user';

    const normalized = __testing.normalizeQueueInput(buildReviewCompletedEvent({
      userId: '00000000-0000-0000-0000-000000000000',
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      completedAt: '2026-03-16T10:00:00.000Z',
      issuesFound: 2,
    }));

    expect(normalized.userId).toBe('guest-user');
  });

  it('builds stable idempotency keys from the normalized payload', () => {
    const one = __testing.buildEventIdempotencyKey({
      eventType: 'review_completed',
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      occurredAt: '2026-03-16T10:00:00.000Z',
      payload: { issuesFound: 2 },
    });
    const two = __testing.buildEventIdempotencyKey({
      eventType: 'review_completed',
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      occurredAt: '2026-03-16T10:00:00.000Z',
      payload: { issuesFound: 2 },
    });

    expect(one).toBe(two);
  });

  it('marks only acknowledged events as synced during flush', async () => {
    process.env.ATLAS_DESKTOP_MODE = 'true';
    process.env.ATLAS_REVIEW_SYNC_SERVER_URL = 'https://sync.example.com';
    process.env.ATLAS_REVIEW_SYNC_AUTH_TOKEN = 'guest-token';
    process.env.ATLAS_REVIEW_SYNC_USER_ID = 'user-1';
    process.env.ATLAS_REVIEW_SYNC_DEVICE_ID = 'device-1';

    const pendingRows = [
      {
        id: 'evt-1',
        user_id: 'user-1',
        device_id: 'device-1',
        event_type: 'review_completed',
        sync_status: 'pending',
        sync_error: null,
        sync_attempt_count: 0,
        synced_at: null,
        project_id: 'proj-1',
        project_name: 'Atlas',
        project_path: '/tmp/atlas',
        review_type: 'branch_review',
        review_id: 'br-1',
        recommendation_key: null,
        event_idempotency_key: 'key-1',
        occurred_at: '2026-03-16T10:00:00.000Z',
        payload_json: JSON.stringify({ issuesFound: 2 }),
        created_at: '2026-03-16T10:00:00.000Z',
        updated_at: '2026-03-16T10:00:00.000Z',
      },
      {
        id: 'evt-2',
        user_id: 'user-1',
        device_id: 'device-1',
        event_type: 'review_completed',
        sync_status: 'pending',
        sync_error: null,
        sync_attempt_count: 0,
        synced_at: null,
        project_id: 'proj-1',
        project_name: 'Atlas',
        project_path: '/tmp/atlas',
        review_type: 'branch_review',
        review_id: 'br-2',
        recommendation_key: null,
        event_idempotency_key: 'key-2',
        occurred_at: '2026-03-16T10:01:00.000Z',
        payload_json: JSON.stringify({ issuesFound: 1 }),
        created_at: '2026-03-16T10:01:00.000Z',
        updated_at: '2026-03-16T10:01:00.000Z',
      },
    ];

    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: pendingRows, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: pendingRows, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        events: [{ idempotencyKey: 'key-1' }],
      }),
    }));

    const result = await flushPendingEvents();

    expect(result).toEqual({
      status: 'partial',
      acknowledged: 1,
      pendingEvents: 1,
      error: '1 event(s) were not acknowledged by server.',
    });
    expect(queryMock).toHaveBeenCalledTimes(6);
    expect(queryMock.mock.calls[0][0]).toContain('UPDATE review_sync_events');
    expect(queryMock.mock.calls[1][0]).toContain('SELECT *');
    expect(queryMock.mock.calls[2][0]).toContain('UPDATE review_sync_events');
    expect(queryMock.mock.calls[3][0]).toContain('SELECT *');
    expect(queryMock.mock.calls[4][1]).toEqual(['user-1', 'evt-1']);
    expect(queryMock.mock.calls[5][1]).toEqual(['user-1', 'Not acknowledged by server', 'evt-2']);
  });

  it('migrates anonymous pending events into the active desktop guest partition', async () => {
    process.env.ATLAS_REVIEW_SYNC_USER_ID = 'guest-user';

    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const status = await getLocalSyncStatus();

    expect(status.pendingEvents).toBe(0);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0]).toContain('UPDATE review_sync_events');
    expect(queryMock.mock.calls[0][1]).toEqual([
      'guest-user',
      '00000000-0000-0000-0000-000000000000',
    ]);
    expect(queryMock.mock.calls[1][1][0]).toBe('guest-user');
  });
});
