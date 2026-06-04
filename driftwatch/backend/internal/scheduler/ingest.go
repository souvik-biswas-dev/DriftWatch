package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/souvik-biswas-dev/driftwatch/internal/docker"
)

// liveKey is the Redis key holding the most recent live snapshot an agent
// pushed for a project.
func liveKey(projectID uuid.UUID) string {
	return fmt.Sprintf("driftwatch:live:%s", projectID.String())
}

// IngestLiveState is called when a project's agent pushes its live Docker state.
// It caches the snapshot (so scheduled and webhook scans can reuse it) and runs
// a drift scan immediately. The backend never connects to the user's Docker host.
func (s *Scheduler) IngestLiveState(projectID uuid.UUID, live *docker.LiveSnapshot) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	if raw, err := json.Marshal(live); err == nil {
		if err := s.rdb.Set(ctx, liveKey(projectID), raw, 24*time.Hour).Err(); err != nil {
			slog.Warn("scheduler: cache live state", "project_id", projectID, "error", err)
		}
	}
	cancel()

	project, err := s.dbQueries.GetProjectByID(context.Background(), projectID)
	if err != nil {
		slog.Error("scheduler: ingest lookup", "project_id", projectID, "error", err)
		return
	}
	s.runProjectScan(project)
}

// lastLiveState returns the most recent snapshot an agent pushed for a project.
func (s *Scheduler) lastLiveState(ctx context.Context, projectID uuid.UUID) (*docker.LiveSnapshot, error) {
	raw, err := s.rdb.Get(ctx, liveKey(projectID)).Result()
	if err != nil {
		return nil, err
	}
	var live docker.LiveSnapshot
	if err := json.Unmarshal([]byte(raw), &live); err != nil {
		return nil, err
	}
	return &live, nil
}
