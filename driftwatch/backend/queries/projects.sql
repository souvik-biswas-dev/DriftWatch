-- name: CreateProject :one
INSERT INTO projects (
    name,
    repo_owner,
    repo_name,
    repo_branch,
    docker_host,
    github_token_encrypted,
    user_id
) VALUES (
    $1, $2, $3, $4, $5, $6, $7
)
RETURNING *;

-- name: GetProjectByID :one
-- Unscoped lookup. Used by the scheduler and webhook (which don't have a
-- user context). HTTP handlers MUST use GetProjectByIDForUser instead.
SELECT *
FROM projects
WHERE id = $1;

-- name: GetProjectByIDForUser :one
SELECT *
FROM projects
WHERE id = $1 AND user_id = $2;

-- name: ListProjects :many
-- Unscoped list — only used by scheduler.LoadAllProjects on boot to
-- register cron entries across every project. NOT for HTTP handlers.
SELECT *
FROM projects
ORDER BY created_at DESC;

-- name: ListProjectsForUser :many
SELECT *
FROM projects
WHERE user_id = $1
ORDER BY created_at DESC;

-- name: ListProjectsByRepo :many
-- Used by the GitHub webhook handler to fan out a TriggerScan to every
-- project that's tracking the repo the push landed on.
SELECT *
FROM projects
WHERE repo_owner = $1 AND repo_name = $2;

-- name: DeleteProjectForUser :execrows
DELETE FROM projects
WHERE id = $1 AND user_id = $2;

-- name: UpdateProject :one
UPDATE projects
SET
    name = $2,
    repo_owner = $3,
    repo_name = $4,
    repo_branch = $5,
    docker_host = $6,
    github_token_encrypted = $7,
    updated_at = now()
WHERE id = $1
RETURNING *;
