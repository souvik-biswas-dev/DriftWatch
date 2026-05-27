package gemini

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/YOURUSERNAME/driftwatch/internal/agent"
)

const validModelJSON = `{
  "severity": "critical",
  "summary": "The web container is missing in production",
  "fixCommand": "docker compose up -d web",
  "explanation": "The web service declared in docker-compose.yml is not present on the host.",
  "driftBreakdown": [
    {
      "containerName": "web",
      "driftType": "missing_container",
      "fixStep": "Bring the web service up with docker compose"
    }
  ]
}`

func newTestClient(srv *httptest.Server) *Client {
	return &Client{
		apiKey:     "fake-key",
		baseURL:    srv.URL,
		http:       srv.Client(),
		retryDelay: 10 * time.Millisecond,
	}
}

func wrapInGeminiResponse(text string) map[string]interface{} {
	return map[string]interface{}{
		"candidates": []map[string]interface{}{
			{
				"content": map[string]interface{}{
					"parts": []map[string]interface{}{
						{"text": text},
					},
				},
			},
		},
	}
}

func TestAnalyze_ParsesValidResponse(t *testing.T) {
	// Wrap in code fence to verify stripping.
	wrapped := "```json\n" + validModelJSON + "\n```"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
		assert.Equal(t, "fake-key", r.URL.Query().Get("key"))

		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), `"contents"`)
		assert.Contains(t, string(body), "missing_container")

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(wrapInGeminiResponse(wrapped))
	}))
	defer srv.Close()

	c := newTestClient(srv)
	drifts := []agent.DriftEvent{
		{
			ID:            "evt-1",
			Type:          agent.DriftTypeMissingContainer,
			ContainerName: "web",
			DeclaredValue: "nginx:1.25",
			Severity:      agent.SeverityCritical,
		},
	}

	result, err := c.Analyze(drifts)
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, "critical", result.Severity)
	assert.Contains(t, result.Summary, "web container")
	assert.Equal(t, "docker compose up -d web", result.FixCommand)
	assert.NotEmpty(t, result.Explanation)
	require.Len(t, result.DriftBreakdown, 1)
	assert.Equal(t, "web", result.DriftBreakdown[0].ContainerName)
	assert.Equal(t, "missing_container", result.DriftBreakdown[0].DriftType)
	assert.NotEmpty(t, result.DriftBreakdown[0].FixStep)
}

func TestAnalyze_EmptyFixCommandIsError(t *testing.T) {
	incomplete := `{
      "severity": "warning",
      "summary": "minor drift",
      "fixCommand": "",
      "explanation": "n/a",
      "driftBreakdown": []
    }`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(wrapInGeminiResponse(incomplete))
	}))
	defer srv.Close()

	c := newTestClient(srv)
	result, err := c.Analyze(nil)
	assert.Nil(t, result)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "incomplete analysis")
}

func TestAnalyze_RetriesOnceOnError(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(wrapInGeminiResponse(validModelJSON))
	}))
	defer srv.Close()

	c := newTestClient(srv)
	result, err := c.Analyze(nil)
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, 2, calls, "expected one retry")
}

func TestStripFences(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"```json\n{\"a\":1}\n```", "{\"a\":1}"},
		{"```\n{\"a\":1}\n```", "{\"a\":1}"},
		{"{\"a\":1}", "{\"a\":1}"},
		{"   ```json\n{\"a\":1}\n```   ", "{\"a\":1}"},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, stripFences(c.in))
	}
}
