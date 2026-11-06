-- Migration: Add file_diff column to chat_messages table
-- Created: 2026-01-17
-- Description: Stores code diff data for Write/Edit tool messages

-- ============================================================================
-- ADD FILE_DIFF COLUMN
-- ============================================================================

ALTER TABLE chat_messages
ADD COLUMN IF NOT EXISTS file_diff JSONB;

-- Comment on column
COMMENT ON COLUMN chat_messages.file_diff IS 'Code diff data for Write/Edit tools: {filePath, beforeContent, afterContent, isNewFile, language, stats}';

-- ============================================================================
-- UPDATE SCHEMA VERSION
-- ============================================================================

INSERT INTO schema_version (version, description)
VALUES (3, 'Add file_diff column to chat_messages')
ON CONFLICT (version) DO NOTHING;
