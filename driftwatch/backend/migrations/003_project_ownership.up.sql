-- Adds per-user ownership to projects. Nullable so existing rows survive
-- the migration; new INSERTs from the API will always populate user_id.
ALTER TABLE projects
    ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX idx_projects_user_id ON projects(user_id);
CREATE INDEX idx_projects_repo ON projects(repo_owner, repo_name);
