package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/souvik-biswas-dev/driftwatch/internal/docker"
)

// agentKeyHeader carries the plaintext agent key when an agent pushes live
// Docker state. The backend only ever stores its SHA-256 hash.
const agentKeyHeader = "X-DriftWatch-Agent-Key"

// hashAgentKey returns the lowercase hex SHA-256 of an agent key.
func hashAgentKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// generateAgentKey returns a new random agent key (prefixed "dw_").
func generateAgentKey() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "dw_" + hex.EncodeToString(b), nil
}

// handleAgentState ingests a live Docker snapshot pushed by a project's agent.
// The agent runs on the user's own host, so the backend never reaches into their
// Docker daemon directly.
func (a *API) handleAgentState(c *gin.Context) {
	key := c.GetHeader(agentKeyHeader)
	if key == "" {
		respondError(c, http.StatusUnauthorized, "missing agent key", "NO_AGENT_KEY")
		return
	}

	project, err := a.queries.GetProjectByAgentKeyHash(c.Request.Context(), hashAgentKey(key))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			respondError(c, http.StatusUnauthorized, "invalid agent key", "BAD_AGENT_KEY")
			return
		}
		respondError(c, http.StatusInternalServerError, "lookup failed", "DB_ERROR")
		return
	}

	var live docker.LiveSnapshot
	if err := c.ShouldBindJSON(&live); err != nil {
		respondError(c, http.StatusBadRequest, err.Error(), "INVALID_BODY")
		return
	}

	// Run the scan asynchronously so the agent gets a fast acknowledgement.
	go a.scheduler.IngestLiveState(project.ID, &live)

	respond(c, http.StatusAccepted, gin.H{"project_id": project.ID}, "state accepted")
}
