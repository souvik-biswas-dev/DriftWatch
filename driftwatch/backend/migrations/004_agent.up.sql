-- Agent-push model: each project gets a long-lived agent key. We store only a
-- SHA-256 hash of it. The user runs a small DriftWatch agent on their own host;
-- the agent reads local Docker and pushes the live state to the backend, so the
-- backend never needs to reach into the user's Docker host. docker_host is
-- therefore no longer required.
ALTER TABLE projects ADD COLUMN agent_key_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ALTER COLUMN docker_host DROP NOT NULL;
ALTER TABLE projects ALTER COLUMN docker_host SET DEFAULT '';

-- One key per project. Partial index so empty (not-yet-issued) keys don't clash.
CREATE UNIQUE INDEX idx_projects_agent_key_hash
    ON projects(agent_key_hash) WHERE agent_key_hash <> '';
