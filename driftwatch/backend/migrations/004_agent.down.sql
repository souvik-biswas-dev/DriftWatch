DROP INDEX IF EXISTS idx_projects_agent_key_hash;
ALTER TABLE projects ALTER COLUMN docker_host DROP DEFAULT;
ALTER TABLE projects ALTER COLUMN docker_host SET NOT NULL;
ALTER TABLE projects DROP COLUMN agent_key_hash;
