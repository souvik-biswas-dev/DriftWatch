package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func (a *API) handleListDrifts(c *gin.Context) {
	project := a.requireProjectOwnership(c)
	if project == nil {
		return
	}

	drifts, err := a.queries.ListDriftEventsByProject(c.Request.Context(), project.ID)
	if err != nil {
		respondError(c, http.StatusInternalServerError, "could not list drift events", "LIST_ERROR")
		return
	}

	respond(c, http.StatusOK, drifts, "")
}

func (a *API) handleGetDrift(c *gin.Context) {
	project := a.requireProjectOwnership(c)
	if project == nil {
		return
	}

	did, err := uuid.Parse(c.Param("driftId"))
	if err != nil {
		respondError(c, http.StatusBadRequest, "invalid drift id", "INVALID_ID")
		return
	}

	drift, err := a.queries.GetDriftEventByID(c.Request.Context(), did)
	if err != nil {
		respondError(c, http.StatusNotFound, "drift event not found", "NOT_FOUND")
		return
	}
	if drift.ProjectID != project.ID {
		respondError(c, http.StatusNotFound, "drift event not found", "NOT_FOUND")
		return
	}

	respond(c, http.StatusOK, drift, "")
}

func (a *API) handleResolveDrift(c *gin.Context) {
	project := a.requireProjectOwnership(c)
	if project == nil {
		return
	}

	did, err := uuid.Parse(c.Param("driftId"))
	if err != nil {
		respondError(c, http.StatusBadRequest, "invalid drift id", "INVALID_ID")
		return
	}

	// Cross-project drift IDs would let one user resolve another's events.
	drift, err := a.queries.GetDriftEventByID(c.Request.Context(), did)
	if err != nil {
		respondError(c, http.StatusNotFound, "drift event not found", "NOT_FOUND")
		return
	}
	if drift.ProjectID != project.ID {
		respondError(c, http.StatusNotFound, "drift event not found", "NOT_FOUND")
		return
	}

	if err := a.queries.ResolveDriftEvent(c.Request.Context(), did); err != nil {
		respondError(c, http.StatusInternalServerError, "could not resolve drift event", "UPDATE_ERROR")
		return
	}

	respond(c, http.StatusOK, nil, "drift event resolved")
}
