-- Context Cortex Schema
-- Run once to initialize the cortex schema in your PostgreSQL database.
-- Requires pgvector extension for embedding columns.

CREATE SCHEMA IF NOT EXISTS cortex;

-- ---------------------------------------------------------------------------
-- Enable pgvector (if not already enabled at DB level)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- 1. code_chunks
-- Core table. One row per semantic chunk of code (function, class, block).
-- Embeddings are 768-dim for nomic-embed-text (Ollama default).
-- Adjust vector(768) if using a different model.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cortex.code_chunks (
    id              BIGSERIAL PRIMARY KEY,
    repo_name       TEXT        NOT NULL,
    file_path       TEXT        NOT NULL,
    relative_path   TEXT        NOT NULL,
    chunk_name      TEXT,
    chunk_type      TEXT,         -- 'function', 'class', 'const', 'block', 'file'
    language        TEXT,
    content         TEXT        NOT NULL,
    content_hash    TEXT        NOT NULL,  -- MD5 of content for dedup / change detection
    start_line      INT,
    end_line        INT,
    file_size       BIGINT,
    file_mtime      TIMESTAMPTZ,
    embedding       vector(768),           -- NULL if Ollama disabled or not yet embedded
    token_estimate  INT,                   -- rough token count (chars / 4)
    meta            JSONB       DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Unique constraint: one chunk per (repo, file, name, type)
CREATE UNIQUE INDEX IF NOT EXISTS code_chunks_repo_file_name_type_idx
    ON cortex.code_chunks (repo_name, relative_path, chunk_name, chunk_type);

-- Fast lookup by repo
CREATE INDEX IF NOT EXISTS code_chunks_repo_idx
    ON cortex.code_chunks (repo_name);

-- Full-text search on content
CREATE INDEX IF NOT EXISTS code_chunks_content_fts_idx
    ON cortex.code_chunks USING GIN (to_tsvector('english', COALESCE(content, '')));

-- Full-text search on chunk name
CREATE INDEX IF NOT EXISTS code_chunks_name_fts_idx
    ON cortex.code_chunks USING GIN (to_tsvector('english', COALESCE(chunk_name, '')));

-- Vector similarity search (requires pgvector)
CREATE INDEX IF NOT EXISTS code_chunks_embedding_idx
    ON cortex.code_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Updated-at trigger helper
CREATE OR REPLACE FUNCTION cortex.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER code_chunks_updated_at
    BEFORE UPDATE ON cortex.code_chunks
    FOR EACH ROW EXECUTE FUNCTION cortex.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. graph_edges
-- Directed edges in the knowledge graph.
-- source_chunk_id → target_chunk_id with a relationship type.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cortex.graph_edges (
    id              BIGSERIAL PRIMARY KEY,
    repo_name       TEXT        NOT NULL,
    source_chunk_id BIGINT      NOT NULL REFERENCES cortex.code_chunks(id) ON DELETE CASCADE,
    target_chunk_id BIGINT      REFERENCES cortex.code_chunks(id) ON DELETE SET NULL,
    edge_type       TEXT        NOT NULL, -- 'import', 'route', 'db_query', 'calls', 'defines'
    label           TEXT,                 -- e.g. import path, route path, SQL table name
    meta            JSONB       DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS graph_edges_repo_idx
    ON cortex.graph_edges (repo_name);

CREATE INDEX IF NOT EXISTS graph_edges_source_idx
    ON cortex.graph_edges (source_chunk_id);

CREATE INDEX IF NOT EXISTS graph_edges_target_idx
    ON cortex.graph_edges (target_chunk_id);

CREATE INDEX IF NOT EXISTS graph_edges_type_idx
    ON cortex.graph_edges (edge_type);

-- ---------------------------------------------------------------------------
-- 3. health_snapshots
-- Point-in-time health check results for services in each repo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cortex.health_snapshots (
    id              BIGSERIAL PRIMARY KEY,
    repo_name       TEXT        NOT NULL,
    service_name    TEXT        NOT NULL,
    service_type    TEXT        NOT NULL, -- 'http', 'tcp', 'docker'
    status          TEXT        NOT NULL, -- 'ok', 'degraded', 'down', 'unknown'
    latency_ms      INT,
    status_code     INT,                  -- HTTP status code if applicable
    error_message   TEXT,
    meta            JSONB       DEFAULT '{}',
    checked_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS health_snapshots_repo_idx
    ON cortex.health_snapshots (repo_name);

CREATE INDEX IF NOT EXISTS health_snapshots_checked_at_idx
    ON cortex.health_snapshots (checked_at DESC);

CREATE INDEX IF NOT EXISTS health_snapshots_status_idx
    ON cortex.health_snapshots (status);

-- ---------------------------------------------------------------------------
-- 4. errors
-- Runtime errors from scanning, embedding, or health checks.
-- Used for observability — not exceptions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cortex.errors (
    id              BIGSERIAL PRIMARY KEY,
    repo_name       TEXT,
    operation       TEXT        NOT NULL, -- 'scan', 'embed', 'health', 'graph', 'dump'
    file_path       TEXT,
    error_code      TEXT,
    message         TEXT        NOT NULL,
    stack           TEXT,
    meta            JSONB       DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS errors_repo_idx
    ON cortex.errors (repo_name);

CREATE INDEX IF NOT EXISTS errors_operation_idx
    ON cortex.errors (operation);

CREATE INDEX IF NOT EXISTS errors_created_at_idx
    ON cortex.errors (created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. scan_log
-- Record of each scan run: duration, files processed, chunks upserted.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cortex.scan_log (
    id              BIGSERIAL PRIMARY KEY,
    repo_name       TEXT        NOT NULL,
    scan_type       TEXT        NOT NULL DEFAULT 'full', -- 'full', 'incremental', 'file'
    status          TEXT        NOT NULL DEFAULT 'running', -- 'running', 'completed', 'failed'
    files_scanned   INT         DEFAULT 0,
    chunks_upserted INT         DEFAULT 0,
    chunks_deleted  INT         DEFAULT 0,
    errors_count    INT         DEFAULT 0,
    duration_ms     INT,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    meta            JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS scan_log_repo_idx
    ON cortex.scan_log (repo_name);

CREATE INDEX IF NOT EXISTS scan_log_started_at_idx
    ON cortex.scan_log (started_at DESC);

-- ---------------------------------------------------------------------------
-- 6. table_ownership
-- Maps database table names to owning repos.
-- Populated by the graph builder when it detects SQL queries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cortex.table_ownership (
    id              BIGSERIAL PRIMARY KEY,
    table_name      TEXT        NOT NULL,
    schema_name     TEXT        NOT NULL DEFAULT 'public',
    repo_name       TEXT        NOT NULL,
    access_type     TEXT        NOT NULL DEFAULT 'readwrite', -- 'readonly', 'readwrite', 'owner'
    detected_in     TEXT[],               -- file paths where this table was referenced
    first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS table_ownership_table_repo_idx
    ON cortex.table_ownership (table_name, schema_name, repo_name);

CREATE INDEX IF NOT EXISTS table_ownership_repo_idx
    ON cortex.table_ownership (repo_name);

CREATE OR REPLACE TRIGGER table_ownership_updated_at
    BEFORE UPDATE ON cortex.table_ownership
    FOR EACH ROW EXECUTE FUNCTION cortex.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. work_log
-- Persistent log of all work done across repos. Auto-injected into CLAUDE.md
-- so every Claude Code session starts knowing exactly what happened before.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cortex.work_log (
    id                  BIGSERIAL PRIMARY KEY,
    repo                TEXT        NOT NULL,
    session_id          TEXT,
    occurred_at         TIMESTAMPTZ DEFAULT NOW(),
    category            TEXT        NOT NULL DEFAULT 'build',
    summary             TEXT        NOT NULL,
    details             TEXT,
    files_touched       TEXT[]      DEFAULT '{}',
    endpoints_affected  TEXT[]      DEFAULT '{}',
    tables_affected     TEXT[]      DEFAULT '{}',
    status              TEXT        NOT NULL DEFAULT 'completed',
    result              TEXT,
    commit_hash         TEXT,
    duration_minutes    INT,
    tags                TEXT[]      DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS work_log_repo_idx
    ON cortex.work_log (repo);

CREATE INDEX IF NOT EXISTS work_log_occurred_at_idx
    ON cortex.work_log (occurred_at DESC);

CREATE INDEX IF NOT EXISTS work_log_session_id_idx
    ON cortex.work_log (session_id);

CREATE INDEX IF NOT EXISTS work_log_status_idx
    ON cortex.work_log (status);

CREATE INDEX IF NOT EXISTS work_log_category_idx
    ON cortex.work_log (category);

-- Dedup: only one entry per commit hash
CREATE UNIQUE INDEX IF NOT EXISTS work_log_commit_hash_idx
    ON cortex.work_log (commit_hash)
    WHERE commit_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 8. decisions
-- Architectural and design decisions logged by Claude Code sessions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cortex.decisions (
    id              SERIAL PRIMARY KEY,
    title           TEXT        NOT NULL,
    decision        TEXT        NOT NULL,
    reasoning       TEXT,
    affected_paths  TEXT[]      DEFAULT '{}',
    tags            TEXT[]      DEFAULT '{}',
    superseded_by   INTEGER     REFERENCES cortex.decisions(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS decisions_created_at_idx
    ON cortex.decisions (created_at DESC);

CREATE INDEX IF NOT EXISTS decisions_title_fts_idx
    ON cortex.decisions USING GIN (to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(decision, '')));

-- ---------------------------------------------------------------------------
-- 9. gotchas
-- Traps, edge cases, and unexpected behaviors discovered during work.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cortex.gotchas (
    id              SERIAL PRIMARY KEY,
    title           TEXT        NOT NULL,
    description     TEXT        NOT NULL,
    solution        TEXT,
    severity        TEXT        DEFAULT 'warning', -- 'critical', 'warning', 'info'
    affected_paths  TEXT[]      DEFAULT '{}',
    resolved_at     TIMESTAMPTZ,
    resolution      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gotchas_created_at_idx
    ON cortex.gotchas (created_at DESC);

CREATE INDEX IF NOT EXISTS gotchas_severity_idx
    ON cortex.gotchas (severity);

CREATE INDEX IF NOT EXISTS gotchas_resolved_idx
    ON cortex.gotchas (resolved_at)
    WHERE resolved_at IS NULL;
