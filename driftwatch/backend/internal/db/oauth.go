package db

import (
	"context"

	"github.com/google/uuid"
)

// Hand-written queries for GitHub OAuth users, kept out of the sqlc-generated
// files so the schema change doesn't require regenerating the whole package.

const upsertGithubUser = `
INSERT INTO users (email, github_id, github_login, avatar_url, github_token_encrypted)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (github_id) WHERE github_id IS NOT NULL
DO UPDATE SET
    email = EXCLUDED.email,
    github_login = EXCLUDED.github_login,
    avatar_url = EXCLUDED.avatar_url,
    github_token_encrypted = EXCLUDED.github_token_encrypted
RETURNING id, email, github_login, avatar_url
`

type UpsertGithubUserParams struct {
	Email                string
	GithubID             int64
	GithubLogin          string
	AvatarURL            string
	GithubTokenEncrypted string
}

type GithubUser struct {
	ID          uuid.UUID
	Email       string
	GithubLogin string
	AvatarURL   string
}

// UpsertGithubUser creates or updates the user identified by their GitHub ID and
// returns the account. The encrypted OAuth token is refreshed on every login.
func (q *Queries) UpsertGithubUser(ctx context.Context, arg UpsertGithubUserParams) (GithubUser, error) {
	row := q.db.QueryRow(ctx, upsertGithubUser,
		arg.Email, arg.GithubID, arg.GithubLogin, arg.AvatarURL, arg.GithubTokenEncrypted)
	var u GithubUser
	err := row.Scan(&u.ID, &u.Email, &u.GithubLogin, &u.AvatarURL)
	return u, err
}

const getUserGithubToken = `SELECT github_token_encrypted FROM users WHERE id = $1`

// GetUserGithubToken returns the encrypted GitHub OAuth token stored for a user,
// used to fetch their private repos. Empty string if none.
func (q *Queries) GetUserGithubToken(ctx context.Context, userID uuid.UUID) (string, error) {
	var enc string
	err := q.db.QueryRow(ctx, getUserGithubToken, userID).Scan(&enc)
	return enc, err
}

const getUserProfile = `SELECT id, email, github_login, avatar_url FROM users WHERE id = $1`

// GetUserProfile returns the public profile fields for the authenticated user.
func (q *Queries) GetUserProfile(ctx context.Context, userID uuid.UUID) (GithubUser, error) {
	row := q.db.QueryRow(ctx, getUserProfile, userID)
	var u GithubUser
	err := row.Scan(&u.ID, &u.Email, &u.GithubLogin, &u.AvatarURL)
	return u, err
}
