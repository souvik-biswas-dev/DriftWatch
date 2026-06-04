package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/souvik-biswas-dev/driftwatch/internal/db"
	"github.com/souvik-biswas-dev/driftwatch/internal/docker"
	"github.com/souvik-biswas-dev/driftwatch/internal/github"
)

// SchedulerAPI is the subset of the scheduler that the HTTP layer drives.
type SchedulerAPI interface {
	RegisterProject(p db.Project)
	UnregisterProject(projectID uuid.UUID)
	TriggerScan(projectID uuid.UUID) error
	IngestLiveState(projectID uuid.UUID, live *docker.LiveSnapshot)
}

type API struct {
	queries       *db.Queries
	scheduler     SchedulerAPI
	githubClient  *github.Client
	jwtSecret     []byte
	webhookSecret string
	oauth         OAuthConfig
}

func New(queries *db.Queries, scheduler SchedulerAPI, githubClient *github.Client, jwtSecret, webhookSecret string, oauth OAuthConfig) *API {
	return &API{
		queries:       queries,
		scheduler:     scheduler,
		githubClient:  githubClient,
		jwtSecret:     []byte(jwtSecret),
		webhookSecret: webhookSecret,
		oauth:         oauth,
	}
}

func (a *API) RegisterRoutes(r *gin.Engine) {
	// Legacy email/password (kept for backward compatibility; the dashboard now
	// uses GitHub OAuth exclusively).
	r.POST("/api/auth/register", a.handleRegister)
	r.POST("/api/auth/login", a.handleLogin)

	// GitHub OAuth: browser hits /login → redirected to GitHub → /callback issues
	// a JWT and redirects back to the dashboard.
	r.GET("/api/auth/github/login", a.handleGithubLogin)
	r.GET("/api/auth/github/callback", a.handleGithubCallback)

	// Internal webhook — verified by shared-secret header, not JWT.
	r.POST("/api/webhook/github", a.handleGitHubWebhook)

	// Agent ingest — authenticated by the per-project agent key header, not JWT.
	r.POST("/api/agent/state", a.handleAgentState)

	protected := r.Group("/api")
	protected.Use(a.authMiddleware())
	{
		protected.GET("/me", a.handleMe)

		protected.POST("/projects", a.handleCreateProject)
		protected.GET("/projects", a.handleListProjects)
		protected.GET("/projects/:id", a.handleGetProject)
		protected.DELETE("/projects/:id", a.handleDeleteProject)

		protected.GET("/projects/:id/drifts", a.handleListDrifts)
		protected.GET("/projects/:id/drifts/:driftId", a.handleGetDrift)
		protected.POST("/projects/:id/drifts/:driftId/resolve", a.handleResolveDrift)

		// GitHub repo/branch picker — returns data from the user's own OAuth token.
		protected.GET("/github/repos", a.handleListUserRepos)
		protected.GET("/github/repos/:owner/:repo/branches", a.handleListRepoBranches)
	}
}

// handleMe returns the authenticated user's public profile (for the dashboard
// header avatar/login).
func (a *API) handleMe(c *gin.Context) {
	uid, ok := currentUserID(c)
	if !ok {
		respondError(c, http.StatusUnauthorized, "auth required", "AUTH_MISSING")
		return
	}
	u, err := a.queries.GetUserProfile(c.Request.Context(), uid)
	if err != nil {
		respondError(c, http.StatusNotFound, "user not found", "NOT_FOUND")
		return
	}
	respond(c, http.StatusOK, gin.H{
		"id":           u.ID,
		"email":        u.Email,
		"github_login": u.GithubLogin,
		"avatar_url":   u.AvatarURL,
	}, "")
}

// respond writes a success envelope: {"data": ..., "message": "..."}.
func respond(c *gin.Context, status int, data interface{}, message string) {
	c.JSON(status, gin.H{"data": data, "message": message})
}

// respondError writes an error envelope: {"error": "...", "code": "..."}.
func respondError(c *gin.Context, status int, errMsg, errCode string) {
	c.JSON(status, gin.H{"error": errMsg, "code": errCode})
}
