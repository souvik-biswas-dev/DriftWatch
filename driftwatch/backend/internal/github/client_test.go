package github

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	gogithub "github.com/google/go-github/v60/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/YOURUSERNAME/driftwatch/internal/docker"
)

const sampleCompose = `services:
  web:
    image: nginx:1.25
    environment:
      - APP_ENV=production
      - VERSION=1.0.0
    ports:
      - "8080:80"
  api:
    image: myapp:v2
    environment:
      DEBUG: "true"
      LOG_LEVEL: info
    ports:
      - "3000:3000"
`

func newTestClient(t *testing.T, handler http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)

	gh := gogithub.NewClient(nil)
	baseURL, err := url.Parse(server.URL + "/")
	require.NoError(t, err)
	gh.BaseURL = baseURL

	return &Client{gh: gh}, server
}

func TestFetchDeclaredConfig_ParsesBothEnvShapes(t *testing.T) {
	handler := func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/repos/acme/widgets/contents/docker-compose.yml", r.URL.Path)
		assert.Equal(t, "main", r.URL.Query().Get("ref"))

		encoded := base64.StdEncoding.EncodeToString([]byte(sampleCompose))
		body := map[string]interface{}{
			"type":     "file",
			"encoding": "base64",
			"name":     "docker-compose.yml",
			"path":     "docker-compose.yml",
			"content":  encoded,
			"sha":      "deadbeef",
			"size":     len(sampleCompose),
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}

	c, srv := newTestClient(t, handler)
	defer srv.Close()

	snap, err := c.FetchDeclaredConfig(context.Background(), "acme", "widgets", "main")
	require.NoError(t, err)
	require.NotNil(t, snap)
	require.Len(t, snap.Containers, 2)

	byName := map[string]docker.ContainerState{}
	for _, ctr := range snap.Containers {
		byName[ctr.Name] = ctr
	}

	web, ok := byName["web"]
	require.True(t, ok, "web service should be present")
	assert.Equal(t, "nginx:1.25", web.Image)
	assert.True(t, web.Running)
	assert.Equal(t, "production", web.Env["APP_ENV"])
	assert.Equal(t, "1.0.0", web.Env["VERSION"])
	assert.Equal(t, []string{"8080:80"}, web.Ports)

	api, ok := byName["api"]
	require.True(t, ok, "api service should be present")
	assert.Equal(t, "myapp:v2", api.Image)
	assert.Equal(t, "true", api.Env["DEBUG"])
	assert.Equal(t, "info", api.Env["LOG_LEVEL"])
	assert.Equal(t, []string{"3000:3000"}, api.Ports)
}

func TestFetchDeclaredConfig_NotFound(t *testing.T) {
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}

	c, srv := newTestClient(t, handler)
	defer srv.Close()

	snap, err := c.FetchDeclaredConfig(context.Background(), "acme", "widgets", "main")
	assert.Nil(t, snap)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "docker-compose.yml not found")
}
