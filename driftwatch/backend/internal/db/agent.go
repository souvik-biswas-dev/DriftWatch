package db

import (
	"context"

	"github.com/google/uuid"
)

// This file is hand-written (not sqlc-generated) so the agent-key and
// per-project secret queries can be added without regenerating the whole db
// package. Column order in the SELECT must match the Project struct's scan
// order in projects.sql.go.

const setProjectAgentKeyHash = "UPDATE projects SET agent_key_hash = $2, updated_at = now() WHERE id = $1"

// SetProjectAgentKeyHash stores the SHA-256 hash of a project's agent key.
func (q *Queries) SetProjectAgentKeyHash(ctx context.Context, id uuid.UUID, keyHash string) error {
	_, err := q.db.Exec(ctx, setProjectAgentKeyHash, id, keyHash)
	return err
}

const setProjectSecrets = "UPDATE projects SET github_token_encrypted = $2, discord_webhook_url = $3, updated_at = now() WHERE id = $1"

// SetProjectSecrets stores a project's (already-encrypted) GitHub token and its
// Discord webhook URL. Pass nil token / empty url to clear them.
func (q *Queries) SetProjectSecrets(ctx context.Context, id uuid.UUID, githubTokenEncrypted *string, discordWebhookURL string) error {
	_, err := q.db.Exec(ctx, setProjectSecrets, id, githubTokenEncrypted, discordWebhookURL)
	return err
}

const hasOpenDriftEvent = `
SELECT EXISTS (
    SELECT 1 FROM drift_events
    WHERE project_id = $1
      AND container_name = $2
      AND drift_type = $3
      AND resolved_at IS NULL
)`

// HasOpenDriftEvent returns true if an identical unresolved drift event already
// exists for this project. Used to prevent duplicate events on each scan cycle.
func (q *Queries) HasOpenDriftEvent(ctx context.Context, projectID uuid.UUID, containerName, driftType string) (bool, error) {
	var exists bool
	err := q.db.QueryRow(ctx, hasOpenDriftEvent, projectID, containerName, driftType).Scan(&exists)
	return exists, err
}

const getProjectByAgentKeyHash = "SELECT id, name, repo_owner, repo_name, repo_branch, docker_host, github_token_encrypted, discord_webhook_url, created_at, updated_at, user_id FROM projects WHERE agent_key_hash = $1"

// GetProjectByAgentKeyHash looks up the project an agent is authorized to push
// state for, given the hash of the key it presented.
func (q *Queries) GetProjectByAgentKeyHash(ctx context.Context, keyHash string) (Project, error) {
	row := q.db.QueryRow(ctx, getProjectByAgentKeyHash, keyHash)
	var i Project
	err := row.Scan(
		&i.ID,
		&i.Name,
		&i.RepoOwner,
		&i.RepoName,
		&i.RepoBranch,
		&i.DockerHost,
		&i.GithubTokenEncrypted,
		&i.DiscordWebhookUrl,
		&i.CreatedAt,
		&i.UpdatedAt,
		&i.UserID,
	)
	return i, err
}
