-- name: CreateDriftEvent :one
INSERT INTO drift_events (
    project_id,
    snapshot_id,
    drift_type,
    container_name,
    live_value,
    declared_value,
    severity,
    ai_summary,
    fix_command
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9
)
RETURNING *;

-- name: ListDriftEventsByProject :many
SELECT *
FROM drift_events
WHERE project_id = $1
ORDER BY created_at DESC
LIMIT 50;

-- name: GetDriftEventByID :one
SELECT *
FROM drift_events
WHERE id = $1;

-- name: GetUnresolvedDriftEvents :many
SELECT *
FROM drift_events
WHERE resolved_at IS NULL
ORDER BY created_at DESC;

-- name: UpdateDriftEventAnalysis :exec
UPDATE drift_events
SET ai_summary = $2, fix_command = $3
WHERE id = $1;

-- name: MarkDriftEventAlerted :exec
UPDATE drift_events
SET alerted_at = now()
WHERE id = $1;

-- name: ResolveDriftEvent :exec
UPDATE drift_events
SET resolved_at = now()
WHERE id = $1;
