// Command agent is the DriftWatch agent. It runs on the user's own host (next
// to their Docker daemon), reads the live container state locally, and pushes it
// to the DriftWatch backend over HTTPS. The backend never connects to the user's
// Docker host, so this works behind NAT/firewalls and keeps the daemon private.
//
// Configuration (environment variables):
//
//	DRIFTWATCH_URL        required  base URL of the backend, e.g. https://driftwatch.example.com
//	DRIFTWATCH_AGENT_KEY  required  the agent key shown once when the project was created
//	DOCKER_HOST           optional  Docker endpoint (default unix:///var/run/docker.sock)
//	SCAN_INTERVAL         optional  how often to push state (default 60s), e.g. 30s, 2m
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/souvik-biswas-dev/driftwatch/internal/docker"
)

func main() {
	if err := run(); err != nil {
		slog.Error("agent fatal", "error", err)
		os.Exit(1)
	}
}

func run() error {
	backendURL := strings.TrimRight(os.Getenv("DRIFTWATCH_URL"), "/")
	agentKey := os.Getenv("DRIFTWATCH_AGENT_KEY")
	dockerHost := os.Getenv("DOCKER_HOST")
	if dockerHost == "" {
		dockerHost = "unix:///var/run/docker.sock"
	}

	if backendURL == "" {
		return fmt.Errorf("DRIFTWATCH_URL is required")
	}
	if agentKey == "" {
		return fmt.Errorf("DRIFTWATCH_AGENT_KEY is required")
	}

	interval := 60 * time.Second
	if v := os.Getenv("SCAN_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return fmt.Errorf("invalid SCAN_INTERVAL %q: %w", v, err)
		}
		interval = d
	}

	dc, err := docker.NewClient(dockerHost)
	if err != nil {
		return fmt.Errorf("connect to docker at %s: %w", dockerHost, err)
	}

	endpoint := backendURL + "/api/agent/state"
	httpClient := &http.Client{Timeout: 15 * time.Second}

	slog.Info("driftwatch agent started",
		"backend", backendURL, "docker_host", dockerHost, "interval", interval.String())

	// Push once immediately, then on every tick.
	pushOnce(dc, httpClient, endpoint, agentKey)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		pushOnce(dc, httpClient, endpoint, agentKey)
	}
	return nil
}

func pushOnce(dc *docker.Client, httpClient *http.Client, endpoint, agentKey string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	snap, err := dc.FetchLiveState(ctx)
	if err != nil {
		slog.Error("read docker state", "error", err)
		return
	}

	body, err := json.Marshal(snap)
	if err != nil {
		slog.Error("marshal snapshot", "error", err)
		return
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		slog.Error("build request", "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-DriftWatch-Agent-Key", agentKey)

	resp, err := httpClient.Do(req)
	if err != nil {
		slog.Error("push state", "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		slog.Error("backend rejected push", "status", resp.StatusCode, "body", strings.TrimSpace(string(msg)))
		return
	}
	slog.Info("pushed live state", "containers", len(snap.Containers), "status", resp.StatusCode)
}
