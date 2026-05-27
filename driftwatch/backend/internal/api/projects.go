package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/YOURUSERNAME/driftwatch/internal/db"
)

type createProjectRequest struct {
	Name                 string  `json:"name" binding:"required"`
	RepoOwner            string  `json:"repo_owner" binding:"required"`
	RepoName             string  `json:"repo_name" binding:"required"`
	RepoBranch           string  `json:"repo_branch"`
	DockerHost           string  `json:"docker_host" binding:"required"`
	GithubTokenEncrypted *string `json:"github_token_encrypted"`
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

	uid := userID
	project, err := a.queries.CreateProject(c.Request.Context(), db.CreateProjectParams{
		Name:                 req.Name,
		RepoOwner:            req.RepoOwner,
		RepoName:             req.RepoName,
		RepoBranch:           req.RepoBranch,
		DockerHost:           req.DockerHost,
		GithubTokenEncrypted: req.GithubTokenEncrypted,
		UserID:               &uid,
	})
	if err != nil {
		respondError(c, http.StatusInternalServerError, "could not create project", "CREATE_ERROR")
		return
	}

	a.scheduler.RegisterProject(project)

	respond(c, http.StatusCreated, project, "project created")
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
	respond(c, http.StatusOK, projects, "")
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
		"project":         project,
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
