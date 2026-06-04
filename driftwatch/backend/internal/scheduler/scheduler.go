package scheduler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/robfig/cron/v3"

	"github.com/souvik-biswas-dev/driftwatch/internal/agent"
	"github.com/souvik-biswas-dev/driftwatch/internal/alerts"
	"github.com/souvik-biswas-dev/driftwatch/internal/crypto"
	"github.com/souvik-biswas-dev/driftwatch/internal/db"
	"github.com/souvik-biswas-dev/driftwatch/internal/gemini"
	"github.com/souvik-biswas-dev/driftwatch/internal/github"
)

// GeminiClient is the surface the scheduler depends on for AI analysis.
// *gemini.Client satisfies this; tests can inject a fake.
type GeminiClient interface {
	Analyze(drifts []agent.DriftEvent) (*gemini.AnalysisResult, error)
}

type Scheduler struct {
	cron         *cron.Cron
	rdb          *redis.Client
	dbQueries    *db.Queries
	githubClient *github.Client
	geminiClient GeminiClient
	alertsClient *alerts.Client

	mu      sync.Mutex
	entries map[uuid.UUID]cron.EntryID
}

func NewScheduler(
	rdb *redis.Client,
	dbQueries *db.Queries,
	githubClient *github.Client,
	geminiClient GeminiClient,
	alertsClient *alerts.Client,
) *Scheduler {
	return &Scheduler{
		cron:         cron.New(),
		rdb:          rdb,
		dbQueries:    dbQueries,
		githubClient: githubClient,
		geminiClient: geminiClient,
		alertsClient: alertsClient,
		entries:      make(map[uuid.UUID]cron.EntryID),
	}
}

func (s *Scheduler) Start() {
	s.cron.Start()
	slog.Info("scheduler started")
}

// Stop waits for in-flight scans to finish before returning.
func (s *Scheduler) Stop() {
	ctx := s.cron.Stop()
	<-ctx.Done()
	slog.Info("scheduler stopped")
}

func (s *Scheduler) RegisterProject(project db.Project) {
	p := project
	entryID, err := s.cron.AddFunc("@every 60s", func() {
		s.runProjectScan(p)
	})
	if err != nil {
		slog.Error("scheduler: register project", "project_id", p.ID, "error", err)
		return
	}
	s.mu.Lock()
	s.entries[p.ID] = entryID
	s.mu.Unlock()
	slog.Info("scheduler: project registered", "project_id", p.ID, "name", p.Name)
}

func (s *Scheduler) UnregisterProject(projectID uuid.UUID) {
	s.mu.Lock()
	entryID, ok := s.entries[projectID]
	if ok {
		delete(s.entries, projectID)
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	s.cron.Remove(entryID)
	slog.Info("scheduler: project unregistered", "project_id", projectID)
}

// TriggerScan runs a scan for the given project immediately, out-of-band
// from the cron schedule. Called by the webhook handler when GitHub pushes
// land on the tracked branch.
func (s *Scheduler) TriggerScan(projectID uuid.UUID) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	project, err := s.dbQueries.GetProjectByID(ctx, projectID)
	if err != nil {
		return fmt.Errorf("scheduler: lookup project: %w", err)
	}
	go s.runProjectScan(project)
	return nil
}

func (s *Scheduler) LoadAllProjects(ctx context.Context) {
	projects, err := s.dbQueries.ListProjects(ctx)
	if err != nil {
		slog.Error("scheduler: load projects", "error", err)
		return
	}
	for _, p := range projects {
		s.RegisterProject(p)
	}
	slog.Info("scheduler: projects loaded", "count", len(projects))
}

// runProjectScan is the per-tick body for a project: pull live state,
// short-circuit via Redis if unchanged, diff against declared state,
// persist, ask the AI for a summary, and alert.
func (s *Scheduler) runProjectScan(project db.Project) {
	log := slog.With("project_id", project.ID, "project_name", project.Name)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Live state is supplied by the project's agent and cached in Redis. The
	// backend never connects to the user's Docker host directly.
	live, err := s.lastLiveState(ctx, project.ID)
	if err != nil {
		log.Info("no agent state cached yet; skipping scan", "error", err)
		return
	}

	liveJSON, err := json.Marshal(live)
	if err != nil {
		log.Error("marshal live state", "error", err)
		return
	}
	sum := sha256.Sum256(liveJSON)
	stateHash := hex.EncodeToString(sum[:])

	redisKey := fmt.Sprintf("driftwatch:hash:%s", project.ID.String())
	prev, err := s.rdb.Get(ctx, redisKey).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		log.Error("redis get", "key", redisKey, "error", err)
	}
	if prev == stateHash {
		log.Info("no change in live state, skipping scan")
		return
	}
	// TTL matches the cron interval so a failed scan (e.g. GitHub fetch error)
	// is retried on the next agent push instead of being skipped permanently.
	if err := s.rdb.Set(ctx, redisKey, stateHash, 2*time.Minute).Err(); err != nil {
		log.Error("redis set", "key", redisKey, "error", err)
	}

	// Resolve the GitHub token used to read this repo, in priority order:
	//   1. the project's own token (if the user pasted one), else
	//   2. the owner's GitHub OAuth token (granted at login with `repo` scope), else
	//   3. empty → unauthenticated (fine for public repos).
	ghToken := ""
	if project.GithubTokenEncrypted != nil && *project.GithubTokenEncrypted != "" {
		if tok, decErr := crypto.Decrypt(*project.GithubTokenEncrypted); decErr != nil {
			log.Error("decrypt project github token", "error", decErr)
		} else {
			ghToken = tok
		}
	}
	if ghToken == "" && project.UserID != nil {
		if enc, err := s.dbQueries.GetUserGithubToken(ctx, *project.UserID); err == nil && enc != "" {
			if tok, decErr := crypto.Decrypt(enc); decErr != nil {
				log.Error("decrypt owner oauth token", "error", decErr)
			} else {
				ghToken = tok
			}
		}
	}

	declared, err := s.githubClient.FetchDeclaredConfigWithToken(ctx, project.RepoOwner, project.RepoName, project.RepoBranch, ghToken)
	if err != nil {
		log.Error("fetch declared config", "error", err)
		return
	}

	declaredJSON, err := json.Marshal(declared)
	if err != nil {
		log.Error("marshal declared state", "error", err)
		return
	}

	// Always create a snapshot so "Last check" reflects every scan, not just
	// scans that found drift.
	snapshot, err := s.dbQueries.CreateSnapshot(ctx, db.CreateSnapshotParams{
		ProjectID:     project.ID,
		StateHash:     stateHash,
		LiveState:     liveJSON,
		DeclaredState: declaredJSON,
	})
	if err != nil {
		log.Error("create snapshot", "error", err)
		return
	}

	drifts := agent.Diff(live, declared)
	if len(drifts) == 0 {
		log.Info("no drift detected")
		return
	}
	log.Info("drift detected", "count", len(drifts))

	type savedDrift struct {
		id    uuid.UUID
		drift agent.DriftEvent
	}
	saved := make([]savedDrift, 0, len(drifts))
	for _, d := range drifts {
		liveVal := d.LiveValue
		decVal := d.DeclaredValue
		evt, err := s.dbQueries.CreateDriftEvent(ctx, db.CreateDriftEventParams{
			ProjectID:     project.ID,
			SnapshotID:    snapshot.ID,
			DriftType:     d.Type,
			ContainerName: d.ContainerName,
			LiveValue:     &liveVal,
			DeclaredValue: &decVal,
			Severity:      d.Severity,
			AiSummary:     nil,
			FixCommand:    nil,
		})
		if err != nil {
			log.Error("create drift event", "drift_type", d.Type, "error", err)
			continue
		}
		saved = append(saved, savedDrift{id: evt.ID, drift: d})
	}

	analysis, err := s.geminiClient.Analyze(drifts)
	if err != nil {
		log.Error("gemini analyze", "error", err)
	}

	if analysis == nil {
		log.Warn("skipping discord alert: no AI analysis available")
		return
	}

	// Backfill per-row AI summary + fix command. Match by (container, type).
	breakdown := make(map[string]string, len(analysis.DriftBreakdown))
	for _, b := range analysis.DriftBreakdown {
		breakdown[b.ContainerName+"|"+b.DriftType] = b.FixStep
	}
	summary := analysis.Summary
	for _, sd := range saved {
		cmd := breakdown[sd.drift.ContainerName+"|"+sd.drift.Type]
		if cmd == "" {
			cmd = analysis.FixCommand
		}
		if err := s.dbQueries.UpdateDriftEventAnalysis(ctx, db.UpdateDriftEventAnalysisParams{
			ID:         sd.id,
			AiSummary:  &summary,
			FixCommand: &cmd,
		}); err != nil {
			log.Error("update drift event analysis", "id", sd.id, "error", err)
		}
	}

	// Alert to the project's own Discord webhook. Empty URL is a clean no-op,
	// so users who don't configure Discord simply get no alert (no error).
	if err := s.alertsClient.SendDriftAlertTo(project.DiscordWebhookUrl, project.Name, analysis, drifts); err != nil {
		log.Error("discord alert", "error", err)
		return
	}
	if project.DiscordWebhookUrl == "" {
		log.Info("scan complete (no discord webhook configured)", "drift_count", len(drifts))
		return
	}

	for _, sd := range saved {
		if err := s.dbQueries.MarkDriftEventAlerted(ctx, sd.id); err != nil {
			log.Error("mark drift event alerted", "id", sd.id, "error", err)
		}
	}

	log.Info("scan complete", "drift_count", len(drifts), "alerted", len(saved))
}
