DROP INDEX IF EXISTS idx_projects_repo;
DROP INDEX IF EXISTS idx_projects_user_id;
ALTER TABLE projects DROP COLUMN IF EXISTS user_id;
