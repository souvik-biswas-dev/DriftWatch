package gemini

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/YOURUSERNAME/driftwatch/internal/agent"
)

// defaultModel is on the Gemini free tier. Override with GEMINI_MODEL, e.g.
// gemini-2.5-flash-lite, gemini-2.0-flash. gemini-1.5-* is being retired.
const (
	defaultModel    = "gemini-2.5-flash"
	baseURLTemplate = "https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent"
)

type AnalysisResult struct {
	Severity       string         `json:"severity"`
	Summary        string         `json:"summary"`
	FixCommand     string         `json:"fixCommand"`
	Explanation    string         `json:"explanation"`
	DriftBreakdown []DriftSummary `json:"driftBreakdown"`
}

type DriftSummary struct {
	ContainerName string `json:"containerName"`
	DriftType     string `json:"driftType"`
	FixStep       string `json:"fixStep"`
}

type Client struct {
	apiKey     string
	baseURL    string
	http       *http.Client
	retryDelay time.Duration
}

func NewClient(apiKey string) *Client {
	model := os.Getenv("GEMINI_MODEL")
	if model == "" {
		model = defaultModel
	}
	return &Client{
		apiKey:     apiKey,
		baseURL:    fmt.Sprintf(baseURLTemplate, model),
		http:       &http.Client{Timeout: 30 * time.Second},
		retryDelay: 2 * time.Second,
	}
}

// On-wire request/response shapes for v1beta generateContent.
type geminiRequest struct {
	Contents []geminiContent `json:"contents"`
}
type geminiContent struct {
	Parts []geminiPart `json:"parts"`
}
type geminiPart struct {
	Text string `json:"text"`
}
type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"content"`
	} `json:"candidates"`
}

// Analyze sends the drift events to Gemini and returns the parsed
// AnalysisResult. On any failure it sleeps retryDelay and tries once more.
func (c *Client) Analyze(drifts []agent.DriftEvent) (*AnalysisResult, error) {
	prompt := buildPrompt(drifts)

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			slog.Warn("gemini: retrying after error", "previous_error", lastErr, "delay", c.retryDelay)
			time.Sleep(c.retryDelay)
		}
		result, err := c.callOnce(prompt)
		if err == nil {
			return result, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("gemini: analyze failed after retry: %w", lastErr)
}

func (c *Client) callOnce(prompt string) (*AnalysisResult, error) {
	body, err := json.Marshal(geminiRequest{
		Contents: []geminiContent{
			{Parts: []geminiPart{{Text: prompt}}},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	endpoint := fmt.Sprintf("%s?key=%s", c.baseURL, url.QueryEscape(c.apiKey))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("post: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("gemini HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var gr geminiResponse
	if err := json.Unmarshal(respBody, &gr); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if len(gr.Candidates) == 0 || len(gr.Candidates[0].Content.Parts) == 0 {
		return nil, errors.New("gemini returned no candidates")
	}

	text := stripFences(gr.Candidates[0].Content.Parts[0].Text)

	var result AnalysisResult
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		return nil, fmt.Errorf("parse model JSON: %w (body: %s)", err, text)
	}
	if result.FixCommand == "" {
		return nil, errors.New("gemini returned incomplete analysis")
	}
	return &result, nil
}

// stripFences removes a leading ```json (or plain ```) and trailing ```
// fence from a model response, since Gemini occasionally ignores our
// "no markdown" instruction.
func stripFences(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "```json")
	s = strings.TrimPrefix(s, "```")
	s = strings.TrimSuffix(s, "```")
	return strings.TrimSpace(s)
}

func buildPrompt(drifts []agent.DriftEvent) string {
	pretty, err := json.MarshalIndent(drifts, "", "  ")
	if err != nil {
		pretty = []byte("[]")
	}

	return fmt.Sprintf(`You are an infrastructure reliability agent analyzing Docker container drift.

The following JSON array contains drift events detected between the live runtime
state of a Docker host and the declared docker-compose.yml configuration in git:

%s

Analyze the drifts and respond with a single JSON object matching exactly this shape:

{
  "severity": "critical | warning | info",
  "summary": "1-2 sentence human-readable summary of what changed",
  "fixCommand": "a single shell command that fixes the most critical drift",
  "explanation": "technical explanation of the most likely root cause",
  "driftBreakdown": [
    {
      "containerName": "name of the container",
      "driftType": "one of env_mismatch | image_stale | port_changed | missing_container | extra_container",
      "fixStep": "specific remediation step for this drift"
    }
  ]
}

Rules:
- Respond with ONLY the JSON object. No markdown fences, no commentary before or after.
- "severity" must be the highest severity across all drifts (critical > warning > info).
- "fixCommand" must be a single executable shell command (e.g. "docker compose up -d --build api").
- "driftBreakdown" must contain exactly one entry per input drift event, matched by container name and drift type.
`, string(pretty))
}
