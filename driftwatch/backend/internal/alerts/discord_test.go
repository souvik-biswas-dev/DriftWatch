package alerts

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
	"github.com/YOURUSERNAME/driftwatch/internal/gemini"
)

func TestSendDriftAlert_PostsExpectedEmbed(t *testing.T) {
	var captured discordPayload

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &captured))
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := NewClient(srv.URL)

	result := &gemini.AnalysisResult{
		Severity:    agent.SeverityCritical,
		Summary:     "Web container is gone in prod",
		FixCommand:  "docker compose up -d web",
		Explanation: "The web service is declared but not running.",
	}
	drifts := []agent.DriftEvent{
		{Type: agent.DriftTypeMissingContainer, ContainerName: "web", Severity: agent.SeverityCritical},
		{Type: agent.DriftTypeEnvMismatch, ContainerName: "web", Severity: agent.SeverityCritical},
		{Type: agent.DriftTypeImageStale, ContainerName: "api", Severity: agent.SeverityWarning},
	}

	err := c.SendDriftAlert("acme-prod", result, drifts)
	require.NoError(t, err)

	require.Len(t, captured.Embeds, 1)
	e := captured.Embeds[0]
	assert.Equal(t, "⚠️ Drift Detected — acme-prod", e.Title)
	assert.Equal(t, 15158332, e.Color)
	require.Len(t, e.Fields, 5)

	byName := make(map[string]discordField, len(e.Fields))
	for _, f := range e.Fields {
		byName[f.Name] = f
	}

	sev := byName["Severity"]
	assert.Equal(t, "critical", sev.Value)
	assert.True(t, sev.Inline, "Severity should be inline")

	count := byName["Containers Affected"]
	assert.Equal(t, "2", count.Value, "web+api are the two unique containers")
	assert.True(t, count.Inline, "Containers Affected should be inline")

	assert.Equal(t, "Web container is gone in prod", byName["Summary"].Value)
	assert.False(t, byName["Summary"].Inline)

	fixField := byName["Fix Command"].Value
	assert.Contains(t, fixField, "```bash")
	assert.Contains(t, fixField, "docker compose up -d web")
	assert.Contains(t, fixField, "```")

	assert.Equal(t, "The web service is declared but not running.", byName["Explanation"].Value)

	assert.Contains(t, e.Footer.Text, "DriftWatch")
	assert.Contains(t, e.Footer.Text, "detected at")
	assert.NotEmpty(t, e.Timestamp)

	// Timestamp should parse as RFC3339.
	_, err = time.Parse(time.RFC3339, e.Timestamp)
	assert.NoError(t, err)
}

func TestSendDriftAlert_ColorBySeverity(t *testing.T) {
	cases := []struct {
		sev      string
		expected int
	}{
		{agent.SeverityCritical, 15158332},
		{agent.SeverityWarning, 16776960},
		{agent.SeverityInfo, 3447003},
	}
	for _, c := range cases {
		assert.Equal(t, c.expected, colorForSeverity(c.sev))
	}
}

func TestSendDriftAlert_NonOKStatusReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"invalid embed"}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	result := &gemini.AnalysisResult{Severity: agent.SeverityInfo, FixCommand: "noop"}
	err := c.SendDriftAlert("p", result, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "400")
	assert.Contains(t, err.Error(), "invalid embed")
}

func TestSendDriftAlert_NilResultIsError(t *testing.T) {
	c := NewClient("https://example.invalid")
	err := c.SendDriftAlert("p", nil, nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "nil")
}

func TestShouldAlert_Cooldown(t *testing.T) {
	c := NewClient("https://example.invalid")

	assert.True(t, c.ShouldAlert("p", nil), "nil lastAlertedAt should allow alert")

	recent := time.Now().Add(-5 * time.Minute)
	assert.False(t, c.ShouldAlert("p", &recent), "5-min-old alert should be in cooldown")

	just := time.Now().Add(-29 * time.Minute)
	assert.False(t, c.ShouldAlert("p", &just), "29-min-old alert should still be in cooldown")

	old := time.Now().Add(-31 * time.Minute)
	assert.True(t, c.ShouldAlert("p", &old), "31-min-old alert should allow new alert")
}
