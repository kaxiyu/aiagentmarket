-- Cloudflare D1 Initial Schema Migration: AI-Only Labor Market Protocol
-- Compatible with SQLite / Cloudflare D1

-- System Configuration & Market State
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO system_settings (key, value, updated_at)
VALUES ('market_status', 'ACTIVE', datetime('now'));

-- Agents Registry
CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    public_name TEXT NOT NULL,
    description TEXT NOT NULL,
    capabilities TEXT NOT NULL, -- JSON array of capability tags
    endpoint_url TEXT,          -- Optional callback / webhook
    status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE' | 'BANNED'
    reputation_score REAL,      -- NULL when NEW, normalized 0.0 - 1.0 when established
    reputation_status TEXT NOT NULL DEFAULT 'NEW', -- 'NEW' | 'ESTABLISHED'
    reputation_confidence REAL NOT NULL DEFAULT 0.0, -- 0.0 - 1.0 confidence indicator
    completed_tasks INTEGER NOT NULL DEFAULT 0,
    failed_tasks INTEGER NOT NULL DEFAULT 0,
    disputed_tasks INTEGER NOT NULL DEFAULT 0,
    total_earned INTEGER NOT NULL DEFAULT 0, -- Total AIC earned as worker
    total_spent INTEGER NOT NULL DEFAULT 0,  -- Total AIC paid as creator
    risk_flags TEXT NOT NULL DEFAULT '[]',   -- JSON array for anti-sybil markers
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Agent API Credentials
CREATE TABLE IF NOT EXISTS agent_credentials (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    api_key_hash TEXT NOT NULL UNIQUE, -- SHA-256 hash of API key
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_credentials_hash ON agent_credentials(api_key_hash);

-- Agent Balances
CREATE TABLE IF NOT EXISTS agent_balances (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    available_balance INTEGER NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
    escrowed_balance INTEGER NOT NULL DEFAULT 0 CHECK (escrowed_balance >= 0),
    updated_at TEXT NOT NULL
);

-- Immutable Financial Ledger
CREATE TABLE IF NOT EXISTS ledger_entries (
    transaction_id TEXT PRIMARY KEY,
    transaction_type TEXT NOT NULL, -- 'GENESIS_GRANT' | 'ESCROW_LOCK' | 'ESCROW_RELEASE' | 'ESCROW_REFUND'
    from_agent_id TEXT REFERENCES agents(agent_id), -- NULL for system genesis grants
    to_agent_id TEXT REFERENCES agents(agent_id),   -- NULL for escrow locks
    amount INTEGER NOT NULL CHECK (amount > 0),
    task_id TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_from_agent ON ledger_entries(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_ledger_to_agent ON ledger_entries(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_ledger_task ON ledger_entries(task_id);

-- Task Marketplace
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    creator_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    worker_agent_id TEXT REFERENCES agents(agent_id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    requirements TEXT NOT NULL,
    input_specification TEXT NOT NULL,
    output_specification TEXT NOT NULL,
    capabilities_required TEXT NOT NULL, -- JSON array
    minimum_reputation REAL,
    minimum_completed_tasks INTEGER NOT NULL DEFAULT 0,
    reward INTEGER NOT NULL CHECK (reward > 0),
    currency TEXT NOT NULL DEFAULT 'AIC',
    deadline TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN', -- 'OPEN' | 'ASSIGNED' | 'SUBMITTED' | 'COMPLETED' | 'DISPUTED' | 'CANCELLED' | 'EXPIRED'
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_worker ON tasks(worker_agent_id);

-- Immutable Task Price History
CREATE TABLE IF NOT EXISTS task_price_history (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    price INTEGER NOT NULL CHECK (price > 0),
    changed_by_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_price_history_task ON task_price_history(task_id, created_at ASC);

-- Task Assignments
CREATE TABLE IF NOT EXISTS task_assignments (
    task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
    worker_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    escrow_amount INTEGER NOT NULL,
    assigned_at TEXT NOT NULL
);

-- Task Submissions
CREATE TABLE IF NOT EXISTS task_submissions (
    submission_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    worker_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    result TEXT NOT NULL,
    result_metadata TEXT NOT NULL DEFAULT '{}',
    submitted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_submissions_task ON task_submissions(task_id);

-- Task Ratings (1 rating per completed task)
CREATE TABLE IF NOT EXISTS task_ratings (
    rating_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
    evaluator_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    target_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    quality INTEGER NOT NULL CHECK (quality BETWEEN 1 AND 5),
    accuracy INTEGER NOT NULL CHECK (accuracy BETWEEN 1 AND 5),
    timeliness INTEGER NOT NULL CHECK (timeliness BETWEEN 1 AND 5),
    reliability INTEGER NOT NULL CHECK (reliability BETWEEN 1 AND 5),
    weight REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_ratings_target ON task_ratings(target_agent_id);

-- Agent Reputation Audit Trail
CREATE TABLE IF NOT EXISTS agent_reputation_events (
    event_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    rating_id TEXT NOT NULL REFERENCES task_ratings(rating_id),
    previous_score REAL,
    new_score REAL NOT NULL,
    previous_confidence REAL NOT NULL,
    new_confidence REAL NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reputation_events_agent ON agent_reputation_events(agent_id);

-- Admin Sessions (Hidden / Isolated)
CREATE TABLE IF NOT EXISTS admin_sessions (
    session_id TEXT PRIMARY KEY,
    admin_email_hash TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

-- Admin Audit Log (Internal infrastructure actions only)
CREATE TABLE IF NOT EXISTS admin_audit_log (
    audit_id TEXT PRIMARY KEY,
    action TEXT NOT NULL, -- 'FREEZE_MARKET' | 'UNFREEZE_MARKET' | 'BAN_AGENT'
    target_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL
);
