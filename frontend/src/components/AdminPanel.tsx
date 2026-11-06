/**
 * Admin Panel Component
 * View Claude Code sessions, Docker containers, and system stats
 */

import { useState, useEffect } from 'react';
import axios from 'axios';
import { getApiBaseUrl } from '@/services/api';
import { getReviewActionButtonStyle } from './review/ReviewChrome';

interface ClaudeSession {
  projectId: string;
  userId: string;
  projectPath: string;
  isActive: boolean;
  messageCount: number;
  tokensUsed: number;
  startTime: number;
  lastActivity: number;
  uptime: number;
  uptimeFormatted: string;
  lastActivityRelative: string;
}

interface SessionsData {
  totalSessions: number;
  activeSessions: number;
  sessions: ClaudeSession[];
}

function AdminPanel() {
  const [sessionsData, setSessionsData] = useState<SessionsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchSessions = async () => {
    try {
      const response = await axios.get(`${getApiBaseUrl().replace('/api', '')}/api/admin/claude-sessions`);
      setSessionsData(response.data);
      setError(null);
    } catch (err) {
      setError('Failed to load session data');
      console.error('Error fetching sessions:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  // Auto-refresh every 5 seconds
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      fetchSessions();
    }, 5000);

    return () => clearInterval(interval);
  }, [autoRefresh]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--review-shell-bg)' }}>
        <div style={{ color: 'var(--text-secondary)' }}>Loading admin data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: 'var(--review-shell-bg)' }}>
        <div className="text-center">
          <p className="text-accent-red mb-2">{error}</p>
          <button
            onClick={fetchSessions}
            style={getReviewActionButtonStyle({ tone: 'blue', active: true })}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--review-shell-bg)' }}>
      {/* Header */}
      <div className="p-4" style={{ borderBottom: '1px solid var(--review-shell-divider)', background: 'var(--review-panel-header-bg)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Admin Panel</h2>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded"
                style={{ accentColor: 'var(--accent-blue)' }}
              />
              Auto-refresh
            </label>
            <button
              onClick={fetchSessions}
              style={getReviewActionButtonStyle({ tone: 'neutral' })}
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {/* Session Stats */}
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Claude Code Sessions</h3>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div
              className="rounded-lg p-4"
              style={{
                background: 'var(--review-card-bg)',
                border: '1px solid var(--review-shell-border)',
                boxShadow: 'var(--review-panel-shadow)',
              }}
            >
              <div className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>Total Sessions</div>
              <div className="text-2xl font-bold text-accent-blue">{sessionsData?.totalSessions || 0}</div>
            </div>
            <div
              className="rounded-lg p-4"
              style={{
                background: 'var(--review-card-bg)',
                border: '1px solid var(--review-shell-border)',
                boxShadow: 'var(--review-panel-shadow)',
              }}
            >
              <div className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>Active Sessions</div>
              <div className="text-2xl font-bold text-accent-green">{sessionsData?.activeSessions || 0}</div>
            </div>
          </div>
        </div>

        {/* Session Details */}
        {sessionsData && sessionsData.sessions.length > 0 ? (
          <div className="space-y-4">
            <h4 className="text-md font-semibold" style={{ color: 'var(--text-primary)' }}>Active Sessions</h4>
            {sessionsData.sessions.map((session, index) => (
              <div
                key={session.projectId}
                className="rounded-lg p-4"
                style={{
                  background: 'var(--review-card-bg)',
                  border: '1px solid var(--review-shell-border)',
                  boxShadow: 'var(--review-panel-shadow)',
                }}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        Session #{index + 1}
                      </span>
                      {session.isActive && (
                        <span
                          className="px-2 py-0.5 rounded text-xs"
                          style={{
                            background: 'var(--chip-success-bg)',
                            color: 'var(--accent-green)',
                            border: '1px solid var(--chip-success-border)',
                          }}
                        >
                          Active
                        </span>
                      )}
                    </div>
                    <div className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
                      {session.projectId}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Uptime</div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {session.uptimeFormatted}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs mb-0.5" style={{ color: 'var(--text-secondary)' }}>Messages</div>
                    <div style={{ color: 'var(--text-primary)' }}>{session.messageCount}</div>
                  </div>
                  <div>
                    <div className="text-xs mb-0.5" style={{ color: 'var(--text-secondary)' }}>Tokens Used</div>
                    <div style={{ color: 'var(--text-primary)' }}>{session.tokensUsed.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs mb-0.5" style={{ color: 'var(--text-secondary)' }}>Last Activity</div>
                    <div style={{ color: 'var(--text-primary)' }}>{session.lastActivityRelative}</div>
                  </div>
                  <div>
                    <div className="text-xs mb-0.5" style={{ color: 'var(--text-secondary)' }}>User ID</div>
                    <div className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                      {session.userId.substring(0, 8)}...
                    </div>
                  </div>
                </div>

                <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--review-shell-divider)' }}>
                  <div className="text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>Project Path</div>
                  <div className="text-xs font-mono truncate" style={{ color: 'var(--text-primary)' }}>
                    {session.projectPath}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div
            className="text-center py-10 px-6 rounded-lg"
            style={{
              background: 'var(--review-panel-bg)',
              border: '1px dashed var(--review-shell-border)',
              color: 'var(--text-tertiary)',
            }}
          >
            <p className="mb-2">No active Claude Code sessions</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Sessions will appear here when users start chatting</p>
          </div>
        )}

        {/* Footer Info */}
        <div
          className="mt-6 p-3 rounded"
          style={{
            background: 'var(--review-card-bg)',
            border: '1px solid var(--review-shell-border)',
          }}
        >
          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            <p className="mb-1">💡 <strong>Tip:</strong> Sessions are created when users send chat messages</p>
            <p>📊 Token usage is tracked per session for cost monitoring</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdminPanel;
