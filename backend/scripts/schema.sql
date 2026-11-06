-- AtlasEngine MVP - Database Schema
-- PostgreSQL 15+
-- Security-hardened with proper constraints and indexes

-- ============================================================================
-- EXTENSIONS
-- ============================================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- USERS TABLE
-- ============================================================================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  is_active BOOLEAN DEFAULT TRUE,
  email_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_login TIMESTAMPTZ
);

-- Index for login queries
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_plan ON users(plan);
CREATE INDEX idx_users_active ON users(is_active);

-- ============================================================================
-- USER QUOTAS TABLE (ENFORCED - NOT OPTIONAL)
-- ============================================================================

CREATE TABLE user_quotas (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Claude API limits
  monthly_token_limit BIGINT DEFAULT 1000000,           -- 1M tokens/month for free tier
  tokens_used_this_month BIGINT DEFAULT 0,
  monthly_cost_limit DECIMAL(10,2) DEFAULT 50.00,      -- $50/month for free tier
  cost_this_month DECIMAL(10,2) DEFAULT 0.00,

  -- Container limits
  max_concurrent_containers INT DEFAULT 1,              -- Free: 1, Pro: 3, Enterprise: 10
  max_container_memory_mb INT DEFAULT 512,              -- Free: 512MB, Pro: 2GB
  max_container_vcpu DECIMAL(3,2) DEFAULT 0.50,        -- Free: 0.5 vCPU, Pro: 2 vCPU

  -- Rate limits
  requests_per_hour INT DEFAULT 50,                     -- Free: 50, Pro: 500
  requests_this_hour INT DEFAULT 0,
  hour_window_start TIMESTAMPTZ DEFAULT NOW(),

  -- Build limits
  max_builds_per_day INT DEFAULT 10,                    -- Free: 10, Pro: 100
  builds_today INT DEFAULT 0,
  day_window_start TIMESTAMPTZ DEFAULT NOW(),

  -- Status
  quota_exceeded BOOLEAN DEFAULT FALSE,
  quota_exceeded_reason TEXT,
  last_reset TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_user_quotas_exceeded ON user_quotas(quota_exceeded);

-- ============================================================================
-- PROJECTS TABLE
-- ============================================================================

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  path TEXT,                                            -- Filesystem path to project
  repo_url TEXT,                                        -- Git repository URL (optional)

  -- Memory system
  has_memory BOOLEAN DEFAULT FALSE,
  memory_size BIGINT DEFAULT 0,                         -- Size in bytes
  last_memory_update TIMESTAMPTZ,

  -- Project origin
  source TEXT DEFAULT 'builder',                        -- 'builder', 'local', 'github'

  -- Branch review base branch
  base_branch_display TEXT,                             -- Display name (e.g. 'main')
  base_branch_ref TEXT,                                 -- Full ref (e.g. 'refs/heads/main')

  -- Project metadata
  framework TEXT,                                       -- 'nextjs', 'vite', 'express', 'flask'
  language TEXT,                                        -- 'typescript', 'javascript', 'python'

  -- Status
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),

  -- CodeGraph integration (migration 023). Spec/status separation: the
  -- toggle is the user's desired enablement; the actual index lifecycle
  -- lives in project_codegraph_indexes (see below).
  codegraph_enabled BOOLEAN DEFAULT TRUE,
  codegraph_current_index_id UUID,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed TIMESTAMPTZ DEFAULT NOW()
);

-- CodeGraph index lifecycle (migration 023). One row per init attempt;
-- "Not initialized" = no row. Re-index creates a new row; old rows kept
-- for history/metrics.
CREATE TABLE IF NOT EXISTS project_codegraph_indexes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('indexing', 'ready', 'error', 'stale')),
  codegraph_version TEXT,
  worktree_sha TEXT,                       -- HEAD SHA at init time; used by I1 review-time gate
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ready_at TIMESTAMPTZ,
  files_indexed INT DEFAULT 0,
  total_files INT DEFAULT 0,
  nodes INT,
  edges INT,
  size_bytes BIGINT,
  error_message TEXT,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_pcg_indexes_project_started
  ON project_codegraph_indexes(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pcg_indexes_project_state
  ON project_codegraph_indexes(project_id, state);

-- Indexes for queries
CREATE INDEX idx_projects_user ON projects(user_id);
CREATE INDEX idx_projects_session ON projects(session_id);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_updated ON projects(updated_at DESC);

-- ============================================================================
-- BUILDS TABLE
-- ============================================================================

CREATE TABLE builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,

  -- Build information
  build_number SERIAL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),

  -- Container information
  builder_container_id TEXT,
  image_id TEXT,

  -- Logs and errors
  build_logs TEXT,
  error_message TEXT,

  -- Timing
  queued_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_seconds INT,

  -- Resources used
  memory_used_mb INT,
  cpu_time_seconds INT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for queries
CREATE INDEX idx_builds_project ON builds(project_id);
CREATE INDEX idx_builds_user ON builds(user_id);
CREATE INDEX idx_builds_status ON builds(status);
CREATE INDEX idx_builds_created ON builds(created_at DESC);

-- ============================================================================
-- PREVIEWS/DEPLOYMENTS TABLE
-- ============================================================================

CREATE TABLE previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  build_id UUID REFERENCES builds(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,

  -- Container information
  container_id TEXT UNIQUE,
  container_name TEXT UNIQUE,
  image_id TEXT,

  -- Network information
  host TEXT NOT NULL,                                   -- proj-123.domain.com
  port INT NOT NULL,                                    -- Internal port (3001-3100)

  -- Status
  status TEXT NOT NULL CHECK (status IN ('starting', 'healthy', 'unhealthy', 'stopped', 'failed')),
  health_check_count INT DEFAULT 0,
  last_health_check TIMESTAMPTZ,

  -- Resource limits
  memory_limit_mb INT DEFAULT 256,
  cpu_limit DECIMAL(3,2) DEFAULT 0.25,

  -- Usage tracking
  request_count BIGINT DEFAULT 0,
  last_accessed TIMESTAMPTZ DEFAULT NOW(),

  -- Auto-sleep configuration
  auto_sleep_enabled BOOLEAN DEFAULT TRUE,
  sleep_after_minutes INT DEFAULT 30,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  stopped_at TIMESTAMPTZ
);

-- Indexes for queries
CREATE INDEX idx_previews_project ON previews(project_id);
CREATE INDEX idx_previews_user ON previews(user_id);
CREATE INDEX idx_previews_status ON previews(status);
CREATE INDEX idx_previews_host ON previews(host);
CREATE INDEX idx_previews_container ON previews(container_id);
CREATE INDEX idx_previews_last_accessed ON previews(last_accessed);

-- ============================================================================
-- MEMORY SNAPSHOTS TABLE (CLAUDE.md version history)
-- ============================================================================

CREATE TABLE memory_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,

  -- Snapshot metadata
  kind TEXT NOT NULL CHECK (kind IN ('claude_md', 'scratch', 'checkpoint', 'auto')),
  path TEXT NOT NULL,                                   -- CLAUDE.md or .claude/file.md

  -- Content
  content TEXT NOT NULL,
  content_hash TEXT,                                    -- SHA256 hash for deduplication
  size_bytes BIGINT NOT NULL,

  -- Context tracking
  context_size INT,                                     -- Estimated tokens

  -- Metadata
  notes TEXT,
  checkpoint_name TEXT,                                 -- For named checkpoints

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for queries
CREATE INDEX idx_memory_snapshots_project ON memory_snapshots(project_id);
CREATE INDEX idx_memory_snapshots_user ON memory_snapshots(user_id);
CREATE INDEX idx_memory_snapshots_kind ON memory_snapshots(kind);
CREATE INDEX idx_memory_snapshots_created ON memory_snapshots(created_at DESC);
CREATE INDEX idx_memory_snapshots_hash ON memory_snapshots(content_hash);

-- ============================================================================
-- USAGE LEDGER TABLE (Billing and tracking)
-- ============================================================================

CREATE TABLE usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,

  -- Usage type
  kind TEXT NOT NULL CHECK (kind IN ('tokens', 'containers', 'build_minutes', 'api_call', 'storage')),

  -- Amount and cost
  amount BIGINT NOT NULL,                               -- Tokens, minutes, bytes, etc.
  cost DECIMAL(10,4) DEFAULT 0.0000,                   -- Cost in USD

  -- Metadata (JSON for flexibility)
  meta JSONB,

  -- Timestamp
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for queries and analytics
CREATE INDEX idx_usage_ledger_user ON usage_ledger(user_id);
CREATE INDEX idx_usage_ledger_project ON usage_ledger(project_id);
CREATE INDEX idx_usage_ledger_kind ON usage_ledger(kind);
CREATE INDEX idx_usage_ledger_created ON usage_ledger(created_at DESC);
CREATE INDEX idx_usage_ledger_user_created ON usage_ledger(user_id, created_at DESC);

-- ============================================================================
-- EVENTS TABLE (Observability and audit trail)
-- ============================================================================

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,

  -- Event context
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,

  -- Event information
  kind TEXT NOT NULL,                                   -- build_started, preview_healthy, quota_exceeded, etc.
  status TEXT,                                          -- success, failure, warning, info
  message TEXT,

  -- Metadata (JSON for flexibility)
  meta JSONB,

  -- IP and user agent for security
  ip_address INET,
  user_agent TEXT,

  -- Timestamp
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for queries and monitoring
CREATE INDEX idx_events_user ON events(user_id);
CREATE INDEX idx_events_project ON events(project_id);
CREATE INDEX idx_events_kind ON events(kind);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_created ON events(created_at DESC);
CREATE INDEX idx_events_user_created ON events(user_id, created_at DESC);

-- ============================================================================
-- SESSIONS TABLE (Optional - for session management)
-- ============================================================================

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,

  -- Session data
  token_hash TEXT UNIQUE NOT NULL,
  ip_address INET,
  user_agent TEXT,

  -- Status
  is_active BOOLEAN DEFAULT TRUE,

  -- Timing
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_activity TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_sessions_active ON sessions(is_active);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ============================================================================
-- CHAT MESSAGES TABLE (Persistent Chat History)
-- ============================================================================

CREATE TABLE chat_messages (
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
CREATE INDEX idx_chat_messages_project ON chat_messages(project_id, created_at DESC);
CREATE INDEX idx_chat_messages_user ON chat_messages(user_id);
CREATE INDEX idx_chat_messages_role ON chat_messages(role);
CREATE INDEX idx_chat_messages_created ON chat_messages(created_at DESC);
CREATE INDEX idx_chat_messages_project_role ON chat_messages(project_id, role);

-- ============================================================================
-- CHAT STREAM STATE TABLE (In-progress Chat Recovery)
-- ============================================================================

CREATE TABLE chat_stream_state (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_stream_state_updated ON chat_stream_state(updated_at DESC);

-- ============================================================================
-- BRANCH REVIEWS TABLE (Branch-level review tracking)
-- ============================================================================

CREATE TABLE branch_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  display_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  merge_base_sha TEXT,
  fork_point_sha TEXT,
  head_sha TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'merged', 'closed', 'stale')),
  is_current BOOLEAN DEFAULT FALSE,
  file_count INTEGER DEFAULT 0,
  total_additions INTEGER DEFAULT 0,
  total_deletions INTEGER DEFAULT 0,
  commit_count INTEGER DEFAULT 0,
  first_commit_at TIMESTAMPTZ,
  last_commit_at TIMESTAMPTZ,
  review_status TEXT DEFAULT 'none'
    CHECK (review_status IN ('none', 'queued', 'reviewing', 'reviewed', 'failed')),
  review_risk_level TEXT,
  review_summary TEXT,
  review_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_branch_reviews_project ON branch_reviews(project_id);
CREATE INDEX idx_branch_reviews_branch ON branch_reviews(project_id, branch_name);
CREATE INDEX idx_branch_reviews_current ON branch_reviews(project_id, is_current);
CREATE INDEX idx_branch_reviews_status ON branch_reviews(status);

COMMENT ON TABLE branch_reviews IS 'Branch-level review tracking for the Trust Pipeline';

-- ============================================================================
-- FUNCTIONS AND TRIGGERS
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to relevant tables
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_quotas_updated_at
  BEFORE UPDATE ON user_quotas
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_previews_updated_at
  BEFORE UPDATE ON previews
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Function to automatically create user quotas when user is created
CREATE OR REPLACE FUNCTION create_default_user_quota()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_quotas (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER create_user_quota_on_signup
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION create_default_user_quota();

-- ============================================================================
-- INITIAL DATA (Optional - for development)
-- ============================================================================

-- Create a test user (password: 'testpass123')
-- Only for development - remove in production!
-- INSERT INTO users (email, password_hash, name, plan, email_verified)
-- VALUES (
--   'test@atlasengine.dev',
--   '$2b$10$rXJZqZ3qGZvFh9pW9eJ9LeXwGLxFLjxUqXvVqBBqQwZqGZqGZqGZq',  -- bcrypt hash
--   'Test User',
--   'free',
--   TRUE
-- );

-- ============================================================================
-- VIEWS (Optional - for analytics)
-- ============================================================================

-- View for user resource usage summary
CREATE OR REPLACE VIEW user_usage_summary AS
SELECT
  u.id AS user_id,
  u.email,
  u.plan,
  uq.tokens_used_this_month,
  uq.cost_this_month,
  uq.quota_exceeded,
  COUNT(DISTINCT p.id) AS project_count,
  COUNT(DISTINCT pr.id) AS active_preview_count,
  COUNT(DISTINCT b.id) FILTER (WHERE b.created_at > NOW() - INTERVAL '24 hours') AS builds_last_24h
FROM users u
LEFT JOIN user_quotas uq ON u.id = uq.user_id
LEFT JOIN projects p ON u.id = p.user_id AND p.status = 'active'
LEFT JOIN previews pr ON u.id = pr.user_id AND pr.status IN ('healthy', 'starting')
LEFT JOIN builds b ON u.id = b.user_id
GROUP BY u.id, u.email, u.plan, uq.tokens_used_this_month, uq.cost_this_month, uq.quota_exceeded;

-- View for project health status
CREATE OR REPLACE VIEW project_health AS
SELECT
  p.id AS project_id,
  p.name,
  p.user_id,
  p.status,
  p.has_memory,
  COUNT(DISTINCT b.id) AS total_builds,
  COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'succeeded') AS successful_builds,
  COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'failed') AS failed_builds,
  MAX(b.created_at) AS last_build_at,
  COUNT(DISTINCT pr.id) FILTER (WHERE pr.status = 'healthy') AS healthy_previews,
  MAX(pr.last_accessed) AS last_preview_access
FROM projects p
LEFT JOIN builds b ON p.id = b.project_id
LEFT JOIN previews pr ON p.id = pr.project_id
GROUP BY p.id, p.name, p.user_id, p.status, p.has_memory;

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

-- ============================================================================
-- COMMENTS (Documentation)
-- ============================================================================

COMMENT ON TABLE users IS 'User accounts and authentication';
COMMENT ON TABLE user_quotas IS 'ENFORCED resource quotas per user - prevents runaway costs';
COMMENT ON TABLE projects IS 'User projects with filesystem paths and memory tracking';
COMMENT ON TABLE builds IS 'Build history with logs and timing';
COMMENT ON TABLE previews IS 'Active container deployments with health status';
COMMENT ON TABLE memory_snapshots IS 'CLAUDE.md version history for session continuity';
COMMENT ON TABLE usage_ledger IS 'Usage tracking for billing and analytics';
COMMENT ON TABLE events IS 'Audit trail and observability events';
COMMENT ON TABLE sessions IS 'User session management';
COMMENT ON TABLE chat_messages IS 'Persistent chat history for Claude Code conversations';

-- ============================================================================
-- SCHEMA VERSION
-- ============================================================================

CREATE TABLE schema_version (
  version INT PRIMARY KEY,
  description TEXT,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_version (version, description) VALUES (1, 'Initial schema with security hardening');

-- ============================================================================
-- COMPLETION MESSAGE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE '✅ AtlasEngine database schema created successfully!';
  RAISE NOTICE 'Tables: users, user_quotas, projects, builds, previews, memory_snapshots, usage_ledger, events, sessions, chat_messages, chat_stream_state';
  RAISE NOTICE 'Views: user_usage_summary, project_health, recent_chat_messages, chat_stats_by_project';
  RAISE NOTICE 'Ready for application initialization';
END $$;
