-- name: CreateSnapshot :one
INSERT INTO snapshots (
    project_id,
    state_hash,
    live_state,
    declared_state
) VALUES (
    $1, $2, $3, $4
)
RETURNING *;

-- name: GetLatestSnapshotByProject :one
SELECT *
FROM snapshots
WHERE project_id = $1
ORDER BY taken_at DESC
LIMIT 1;
