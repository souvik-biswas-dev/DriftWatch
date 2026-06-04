package api

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/souvik-biswas-dev/driftwatch/internal/db"
)

// githubWebhookRequest is the envelope the Cloudflare worker forwards
// after verifying GitHub's HMAC. The worker strips GitHub's verbose
// payload down to just the fields we need.
type githubWebhookRequest struct {
	RepoFullName  string `json:"repo_full_name" binding:"required"`
	Ref           string `json:"ref"`
	HeadCommitSHA string `json:"head_commit_sha"`
}

// handleGitHubWebhook is called by the Cloudflare worker after it has
// verified GitHub's signature. We trust the worker via X-DriftWatch-Secret
// and fan out a TriggerScan to every project tracking the pushed repo —
// multiple users can monitor the same repo on different Docker hosts.
func (a *API) handleGitHubWebhook(c *gin.Context) {
	if a.webhookSecret == "" {
		respondError(c, http.StatusServiceUnavailable, "webhook not configured", "WEBHOOK_DISABLED")
		return
	}
	got := c.GetHeader("X-DriftWatch-Secret")
	if subtle.ConstantTimeCompare([]byte(got), []byte(a.webhookSecret)) != 1 {
		respondError(c, http.StatusUnauthorized, "invalid webhook secret", "WEBHOOK_AUTH")
		return
	}

	var req githubWebhookRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		respondError(c, http.StatusBadRequest, err.Error(), "VALIDATION_ERROR")
		return
	}

	parts := strings.SplitN(req.RepoFullName, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		respondError(c, http.StatusBadRequest, "repo_full_name must be 'owner/name'", "INVALID_REPO")
		return
	}
	owner, name := parts[0], parts[1]

	projects, err := a.queries.ListProjectsByRepo(c.Request.Context(), db.ListProjectsByRepoParams{
		RepoOwner: owner,
		RepoName:  name,
	})
	if err != nil {
		respondError(c, http.StatusInternalServerError, "lookup failed", "LOOKUP_ERROR")
		return
	}
	if len(projects) == 0 {
		// No project tracks this repo — acknowledge but no-op so GitHub
		// doesn't retry. The worker has already verified the signature.
		respond(c, http.StatusAccepted, gin.H{"matched": 0, "triggered": 0}, "no projects match repo")
		return
	}

	triggered := 0
	for _, p := range projects {
		if err := a.scheduler.TriggerScan(p.ID); err != nil {
			slog.Error("webhook: trigger scan", "project_id", p.ID, "error", err)
			continue
		}
		triggered++
	}

	respond(c, http.StatusAccepted, gin.H{
		"matched":   len(projects),
		"triggered": triggered,
		"ref":       req.Ref,
	}, "scans triggered")
}
