package api

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/YOURUSERNAME/driftwatch/internal/db"
	"github.com/YOURUSERNAME/driftwatch/internal/docker"
)

// SchedulerAPI is the subset of the scheduler that the HTTP layer drives.
// The concrete scheduler.Scheduler must satisfy this interface — note
// UnregisterProject and TriggerScan are new methods that still need to be
// added to internal/scheduler/scheduler.go.
type SchedulerAPI interface {
	RegisterProject(p db.Project)
	UnregisterProject(projectID uuid.UUID)
	TriggerScan(projectID uuid.UUID) error
	IngestLiveState(projectID uuid.UUID, live *docker.LiveSnapshot)
}

type API struct {
	queries       *db.Queries
	scheduler     SchedulerAPI
	jwtSecret     []byte
	webhookSecret string
}

func New(queries *db.Queries, scheduler SchedulerAPI, jwtSecret, webhookSecret string) *API {
	return &API{
		queries:       queries,
		scheduler:     scheduler,
		jwtSecret:     []byte(jwtSecret),
		webhookSecret: webhookSecret,
	}
}

func (a *API) RegisterRoutes(r *gin.Engine) {
	r.POST("/api/auth/register", a.handleRegister)
	r.POST("/api/auth/login", a.handleLogin)

	// Internal webhook — verified by shared-secret header, not JWT.
	r.POST("/api/webhook/github", a.handleGitHubWebhook)

	// Agent ingest — authenticated by the per-project agent key header, not JWT.
	r.POST("/api/agent/state", a.handleAgentState)

	protected := r.Group("/api")
	protected.Use(a.authMiddleware())
	{
		protected.POST("/projects", a.handleCreateProject)
		protected.GET("/projects", a.handleListProjects)
		protected.GET("/projects/:id", a.handleGetProject)
		protected.DELETE("/projects/:id", a.handleDeleteProject)

		protected.GET("/projects/:id/drifts", a.handleListDrifts)
		protected.GET("/projects/:id/drifts/:driftId", a.handleGetDrift)
		protected.POST("/projects/:id/drifts/:driftId/resolve", a.handleResolveDrift)
	}
}

// respond writes a success envelope: {"data": ..., "message": "..."}.
func respond(c *gin.Context, status int, data interface{}, message string) {
	c.JSON(status, gin.H{"data": data, "message": message})
}

// respondError writes an error envelope: {"error": "...", "code": "..."}.
func respondError(c *gin.Context, status int, errMsg, errCode string) {
	c.JSON(status, gin.H{"error": errMsg, "code": errCode})
}
