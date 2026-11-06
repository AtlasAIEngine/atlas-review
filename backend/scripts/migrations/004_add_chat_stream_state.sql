-- Migration: Add chat_stream_state table for chat stream recovery
-- Created: 2026-01-14
-- Description: Stores in-progress chat stream content for reconnect recovery

-- ============================================================================
-- CHAT STREAM STATE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS chat_stream_state (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_stream_state_updated ON chat_stream_state(updated_at DESC);

COMMENT ON TABLE chat_stream_state IS 'Stores in-progress chat stream content for reconnect recovery';
COMMENT ON COLUMN chat_stream_state.content IS 'Accumulated assistant response content while streaming';
COMMENT ON COLUMN chat_stream_state.started_at IS 'When the stream started';
COMMENT ON COLUMN chat_stream_state.updated_at IS 'When the stream content was last updated';
