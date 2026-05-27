CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    repo_branch TEXT NOT NULL DEFAULT 'main',
    docker_host TEXT NOT NULL,
    github_token_encrypted TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    state_hash TEXT NOT NULL,
    live_state JSONB NOT NULL,
    declared_state JSONB NOT NULL,
    taken_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE drift_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    snapshot_id UUID NOT NULL REFERENCES snapshots(id),
    drift_type TEXT NOT NULL CHECK (drift_type IN ('env_mismatch', 'image_stale', 'port_changed', 'missing_container', 'extra_container')),
    container_name TEXT NOT NULL,
    live_value TEXT,
    declared_value TEXT,
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
    ai_summary TEXT,
    fix_command TEXT,
    alerted_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_snapshots_project_id ON snapshots(project_id);
CREATE INDEX idx_drift_events_project_id ON drift_events(project_id);
CREATE INDEX idx_drift_events_created_at ON drift_events(created_at DESC);
