-- Migration: Add chat_messages table for persistent chat history
-- Created: 2025-10-20
-- Description: Stores all chat messages between users and Claude Code

-- ============================================================================
-- CHAT MESSAGES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,

  -- Message content
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,

  -- Metadata
  tokens_used INT DEFAULT 0,
  model TEXT,
  meta JSONB,  -- For tool use, attachments, code execution, etc.

  -- Status
  is_deleted BOOLEAN DEFAULT FALSE,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_role ON chat_messages(role);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_project_role ON chat_messages(project_id, role);

-- Comment on table
COMMENT ON TABLE chat_messages IS 'Stores all chat messages for persistent conversation history across sessions';
COMMENT ON COLUMN chat_messages.role IS 'Message role: user (human), assistant (Claude), or system (platform notifications)';
COMMENT ON COLUMN chat_messages.content IS 'The actual message content';
COMMENT ON COLUMN chat_messages.tokens_used IS 'Number of tokens consumed by this message (for cost tracking)';
COMMENT ON COLUMN chat_messages.model IS 'Claude model used for this response (e.g., claude-3-sonnet)';
COMMENT ON COLUMN chat_messages.meta IS 'Additional metadata: tool calls, code execution results, etc.';
COMMENT ON COLUMN chat_messages.is_deleted IS 'Soft delete flag for message moderation/cleanup';

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- View for recent chat messages by project
CREATE OR REPLACE VIEW recent_chat_messages AS
SELECT
  cm.*,
  p.name as project_name,
  u.email as user_email
FROM chat_messages cm
JOIN projects p ON cm.project_id = p.id
LEFT JOIN users u ON cm.user_id = u.id
WHERE cm.is_deleted = FALSE
ORDER BY cm.created_at DESC;

-- View for chat statistics by project
CREATE OR REPLACE VIEW chat_stats_by_project AS
SELECT
  project_id,
  COUNT(*) as total_messages,
  COUNT(CASE WHEN role = 'user' THEN 1 END) as user_messages,
  COUNT(CASE WHEN role = 'assistant' THEN 1 END) as assistant_messages,
  SUM(tokens_used) as total_tokens,
  MIN(created_at) as first_message_at,
  MAX(created_at) as last_message_at
FROM chat_messages
WHERE is_deleted = FALSE
GROUP BY project_id;

COMMENT ON VIEW chat_stats_by_project IS 'Aggregated statistics for chat activity per project';
