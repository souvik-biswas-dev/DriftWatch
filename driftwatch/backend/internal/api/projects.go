package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/YOURUSERNAME/driftwatch/internal/crypto"
	"github.com/YOURUSERNAME/driftwatch/internal/db"
)

type createProjectRequest struct {
	Name       string `json:"name" binding:"required"`
	RepoOwner  string `json:"repo_owner" binding:"required"`
	RepoName   string `json:"repo_name" binding:"required"`
	RepoBranch string `json:"repo_branch"`
	// Optional. Only needed for PRIVATE repos. Stored encrypted at rest.
	GithubToken string `json:"github_token"`
	// Optional. Per-project Discord webhook for drift alerts. Blank = no alerts.
	DiscordWebhookURL string `json:"discord_webhook_url"`
}

// projectResponse is the safe public shape of a project: it never exposes the
// stored secrets. Instead it reports whether they are set.
type projectResponse struct {
	ID             uuid.UUID `json:"id"`
	Name           string    `json:"name"`
	RepoOwner      string    `json:"repo_owner"`
	RepoName       string    `json:"repo_name"`
	RepoBranch     string    `json:"repo_branch"`
	HasGithubToken bool      `json:"has_github_token"`
	HasDiscord     bool      `json:"has_discord_webhook"`
	CreatedAt      any       `json:"created_at"`
	UpdatedAt      any       `json:"updated_at"`
	UserID         any       `json:"user_id"`
}

func toProjectResponse(p db.Project) projectResponse {
	return projectResponse{
		ID:             p.ID,
		Name:           p.Name,
		RepoOwner:      p.RepoOwner,
		RepoName:       p.RepoName,
		RepoBranch:     p.RepoBranch,
		HasGithubToken: p.GithubTokenEncrypted != nil && *p.GithubTokenEncrypted != "",
		HasDiscord:     p.DiscordWebhookUrl != "",
		CreatedAt:      p.CreatedAt,
		UpdatedAt:      p.UpdatedAt,
		UserID:         p.UserID,
	}
}

func toProjectResponses(ps []db.Project) []projectResponse {
	out := make([]projectResponse, 0, len(ps))
	for _, p := range ps {
		out = append(out, toProjectResponse(p))
	}
	return out
}

func (a *API) handleCreateProject(c *gin.Context) {
	userID, ok := currentUserID(c)
	if !ok {
		respondError(c, http.StatusUnauthorized, "auth required", "AUTH_MISSING")
		return
	}

	var req createProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
		return
	}
	if req.RepoBranch == "" {
		req.RepoBranch = "main"
	}

	// Encrypt the user's GitHub token (if any) before it ever touches the DB.
	var encToken *string
	if req.GithubToken != "" {
		ct, encErr := crypto.Encrypt(req.GithubToken)
		if encErr != nil {
			respondError(c, http.StatusInternalServerError, "could not secure github token", "ENCRYPT_ERROR")
			return
		}
		encToken = &ct
	}

	uid := userID
	project, err := a.queries.CreateProject(c.Request.Context(), db.CreateProjectParams{
		Name:                 req.Name,
		RepoOwner:            req.RepoOwner,
		RepoName:             req.RepoName,
		RepoBranch:           req.RepoBranch,
		DockerHost:           "", // unused in agent-push model; column kept for compatibility
		GithubTokenEncrypted: encToken,
		UserID:               &uid,
	})
	if err != nil {
		respondError(c, http.StatusInternalServerError, "could not create project", "CREATE_ERROR")
		return
	}

	// Persist the optional per-project Discord webhook alongside the (already
	// stored) encrypted token.
	if req.DiscordWebhookURL != "" {
		if err := a.queries.SetProjectSecrets(c.Request.Context(), project.ID, encToken, req.DiscordWebhookURL); err != nil {
			respondError(c, http.StatusInternalServerError, "could not store project secrets", "SECRET_STORE_ERROR")
			return
		}
		project.DiscordWebhookUrl = req.DiscordWebhookURL
	}

	// Issue a one-time agent key. Only its SHA-256 hash is stored; the plaintext
	// is returned here once and never shown again. The user gives it to the agent.
	agentKey, err := generateAgentKey()
	if err != nil {
		respondError(c, http.StatusInternalServerError, "could not issue agent key", "KEY_ERROR")
		return
	}
	if err := a.queries.SetProjectAgentKeyHash(c.Request.Context(), project.ID, hashAgentKey(agentKey)); err != nil {
		respondError(c, http.StatusInternalServerError, "could not store agent key", "KEY_STORE_ERROR")
		return
	}

	a.scheduler.RegisterProject(project)

	// Keep the standard {data, message} envelope. `data` is the sanitized
	// project (no secrets); the one-time agent_key is a sibling field.
	c.JSON(http.StatusCreated, gin.H{
		"data":      toProjectResponse(project),
		"agent_key": agentKey,
		"message":   "project created — save the agent_key now, it is shown only once",
	})
}

func (a *API) handleListProjects(c *gin.Context) {
	userID, ok := currentUserID(c)
	if !ok {
		respondError(c, http.StatusUnauthorized, "auth required", "AUTH_MISSING")
		return
	}
	uid := userID
	projects, err := a.queries.ListProjectsForUser(c.Request.Context(), &uid)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "could not list projects", "LIST_ERROR")
		return
	}
	respond(c, http.StatusOK, toProjectResponses(projects), "")
}

func (a *API) handleGetProject(c *gin.Context) {
	userID, ok := currentUserID(c)
	if !ok {
		respondError(c, http.StatusUnauthorized, "auth required", "AUTH_MISSING")
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		respondError(c, http.StatusBadRequest, "invalid project id", "INVALID_ID")
		return
	}

	uid := userID
	project, err := a.queries.GetProjectByIDForUser(c.Request.Context(), db.GetProjectByIDForUserParams{
		ID:     id,
		UserID: &uid,
	})
	if err != nil {
		respondError(c, http.StatusNotFound, "project not found", "NOT_FOUND")
		return
	}

	snapshot, snapErr := a.queries.GetLatestSnapshotByProject(c.Request.Context(), id)
	var snapshotPayload interface{}
	if snapErr == nil {
		snapshotPayload = snapshot
	}

	respond(c, http.StatusOK, gin.H{
		"project":         toProjectResponse(project),
		"latest_snapshot": snapshotPayload,
	}, "")
}

func (a *API) handleDeleteProject(c *gin.Context) {
	userID, ok := currentUserID(c)
	if !ok {
		respondError(c, http.StatusUnauthorized, "auth required", "AUTH_MISSING")
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		respondError(c, http.StatusBadRequest, "invalid project id", "INVALID_ID")
		return
	}

	uid := userID
	rows, err := a.queries.DeleteProjectForUser(c.Request.Context(), db.DeleteProjectForUserParams{
		ID:     id,
		UserID: &uid,
	})
	if err != nil {
		respondError(c, http.StatusInternalServerError, "could not delete project", "DELETE_ERROR")
		return
	}
	if rows == 0 {
		respondError(c, http.StatusNotFound, "project not found", "NOT_FOUND")
		return
	}

	a.scheduler.UnregisterProject(id)

	respond(c, http.StatusOK, nil, "project deleted")
}

// requireProjectOwnership verifies that the authenticated user owns the
// project identified by the :id URL param. Returns the project on success
// or writes an appropriate error response and returns nil on failure.
func (a *API) requireProjectOwnership(c *gin.Context) *db.Project {
	userID, ok := currentUserID(c)
	if !ok {
		respondError(c, http.StatusUnauthorized, "auth required", "AUTH_MISSING")
		return nil
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		respondError(c, http.StatusBadRequest, "invalid project id", "INVALID_ID")
		return nil
	}
	uid := userID
	p, err := a.queries.GetProjectByIDForUser(c.Request.Context(), db.GetProjectByIDForUserParams{
		ID:     id,
		UserID: &uid,
	})
	if err != nil {
		respondError(c, http.StatusNotFound, "project not found", "NOT_FOUND")
		return nil
	}
	return &p
}
