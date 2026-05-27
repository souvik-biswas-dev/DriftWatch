package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/YOURUSERNAME/driftwatch/internal/agent"
	"github.com/YOURUSERNAME/driftwatch/internal/gemini"
)

const cooldownPeriod = 30 * time.Minute

type Client struct {
	webhookURL string
	http       *http.Client
}

func NewClient(webhookURL string) *Client {
	return &Client{
		webhookURL: webhookURL,
		http:       &http.Client{Timeout: 10 * time.Second},
	}
}

// Discord webhook payload shapes.
type discordPayload struct {
	Embeds []discordEmbed `json:"embeds"`
}

type discordEmbed struct {
	Title     string         `json:"title"`
	Color     int            `json:"color"`
	Fields    []discordField `json:"fields"`
	Footer    discordFooter  `json:"footer"`
	Timestamp string         `json:"timestamp"`
}

type discordField struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Inline bool   `json:"inline,omitempty"`
}

type discordFooter struct {
	Text string `json:"text"`
}

func colorForSeverity(sev string) int {
	switch sev {
	case agent.SeverityCritical:
		return 15158332 // red
	case agent.SeverityWarning:
		return 16776960 // yellow
	case agent.SeverityInfo:
		return 3447003 // blue
	default:
		return 3447003
	}
}

func uniqueContainerCount(drifts []agent.DriftEvent) int {
	seen := make(map[string]struct{}, len(drifts))
	for _, d := range drifts {
		seen[d.ContainerName] = struct{}{}
	}
	return len(seen)
}

func (c *Client) SendDriftAlert(projectName string, result *gemini.AnalysisResult, drifts []agent.DriftEvent) error {
	if result == nil {
		return errors.New("alerts: AnalysisResult is nil")
	}

	now := time.Now().UTC()
	timestamp := now.Format(time.RFC3339)

	embed := discordEmbed{
		Title: fmt.Sprintf("⚠️ Drift Detected — %s", projectName),
		Color: colorForSeverity(result.Severity),
		Fields: []discordField{
			{Name: "Severity", Value: result.Severity, Inline: true},
			{Name: "Containers Affected", Value: fmt.Sprintf("%d", uniqueContainerCount(drifts)), Inline: true},
			{Name: "Summary", Value: result.Summary},
			{Name: "Fix Command", Value: fmt.Sprintf("```bash\n%s\n```", result.FixCommand)},
			{Name: "Explanation", Value: result.Explanation},
		},
		Footer:    discordFooter{Text: fmt.Sprintf("DriftWatch • detected at %s", timestamp)},
		Timestamp: timestamp,
	}

	body, err := json.Marshal(discordPayload{Embeds: []discordEmbed{embed}})
	if err != nil {
		return fmt.Errorf("marshal discord payload: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.webhookURL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build discord request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("discord post: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("discord webhook returned %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// ShouldAlert returns true if it's been at least 30 minutes since the last
// alert for this project (or there's no prior alert recorded).
//
// projectID is accepted for forward compatibility with per-project state,
// but the current implementation is stateless and relies on the caller to
// pass the last-alerted timestamp from the DB.
func (c *Client) ShouldAlert(projectID string, lastAlertedAt *time.Time) bool {
	_ = projectID
	if lastAlertedAt == nil {
		return true
	}
	return time.Since(*lastAlertedAt) >= cooldownPeriod
}
