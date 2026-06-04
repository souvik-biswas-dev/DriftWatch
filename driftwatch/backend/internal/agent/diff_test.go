package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/souvik-biswas-dev/driftwatch/internal/docker"
)

// expectDrift is the projection of DriftEvent that we assert on in tests.
// ID and DetectedAt are checked separately since they're non-deterministic.
type expectDrift struct {
	Type          string
	ContainerName string
	Severity      string
	LiveValue     string
	DeclaredValue string
}

func project(e DriftEvent) expectDrift {
	return expectDrift{
		Type:          e.Type,
		ContainerName: e.ContainerName,
		Severity:      e.Severity,
		LiveValue:     e.LiveValue,
		DeclaredValue: e.DeclaredValue,
	}
}

func snap(containers ...docker.ContainerState) *docker.LiveSnapshot {
	return &docker.LiveSnapshot{Containers: containers}
}

func ctr(name, image string, env map[string]string, ports []string) docker.ContainerState {
	if env == nil {
		env = map[string]string{}
	}
	return docker.ContainerState{
		Name:    name,
		Image:   image,
		Env:     env,
		Ports:   ports,
		Running: true,
	}
}

func envMap(pairs ...string) map[string]string {
	out := map[string]string{}
	for i := 0; i+1 < len(pairs); i += 2 {
		out[pairs[i]] = pairs[i+1]
	}
	return out
}

func TestDiff(t *testing.T) {
	cases := []struct {
		name     string
		live     *docker.LiveSnapshot
		declared *docker.LiveSnapshot
		want     []expectDrift
	}{
		{
			name:     "no drift when snapshots match",
			live:     snap(ctr("web", "nginx:1.25", nil, nil)),
			declared: snap(ctr("web", "nginx:1.25", nil, nil)),
			want:     nil,
		},

		// MissingContainer
		{
			name:     "missing container: declared web, live empty",
			live:     snap(),
			declared: snap(ctr("web", "nginx:1.25", nil, nil)),
			want: []expectDrift{
				{Type: DriftTypeMissingContainer, ContainerName: "web", Severity: SeverityCritical, DeclaredValue: "nginx:1.25"},
			},
		},
		{
			name: "missing container: api absent while web present",
			live: snap(ctr("web", "nginx:1.25", nil, nil)),
			declared: snap(
				ctr("web", "nginx:1.25", nil, nil),
				ctr("api", "myapp:v2", nil, nil),
			),
			want: []expectDrift{
				{Type: DriftTypeMissingContainer, ContainerName: "api", Severity: SeverityCritical, DeclaredValue: "myapp:v2"},
			},
		},

		// ExtraContainer
		{
			name:     "extra container: live has web, declared empty",
			live:     snap(ctr("web", "nginx:1.25", nil, nil)),
			declared: snap(),
			want: []expectDrift{
				{Type: DriftTypeExtraContainer, ContainerName: "web", Severity: SeverityInfo, LiveValue: "nginx:1.25"},
			},
		},
		{
			name: "extra container: debug running but not declared",
			live: snap(
				ctr("web", "nginx:1.25", nil, nil),
				ctr("debug", "busybox:latest", nil, nil),
			),
			declared: snap(ctr("web", "nginx:1.25", nil, nil)),
			want: []expectDrift{
				{Type: DriftTypeExtraContainer, ContainerName: "debug", Severity: SeverityInfo, LiveValue: "busybox:latest"},
			},
		},

		// ImageStale
		{
			name:     "image stale: nginx tag bumped",
			live:     snap(ctr("web", "nginx:1.25", nil, nil)),
			declared: snap(ctr("web", "nginx:1.26", nil, nil)),
			want: []expectDrift{
				{Type: DriftTypeImageStale, ContainerName: "web", Severity: SeverityWarning, LiveValue: "nginx:1.25", DeclaredValue: "nginx:1.26"},
			},
		},
		{
			name:     "image stale: api v1 in live, v2 declared",
			live:     snap(ctr("api", "myapp:v1", nil, nil)),
			declared: snap(ctr("api", "myapp:v2", nil, nil)),
			want: []expectDrift{
				{Type: DriftTypeImageStale, ContainerName: "api", Severity: SeverityWarning, LiveValue: "myapp:v1", DeclaredValue: "myapp:v2"},
			},
		},

		// EnvMismatch
		{
			name:     "env mismatch (warning): APP_ENV drift",
			live:     snap(ctr("web", "nginx:1.25", envMap("APP_ENV", "dev"), nil)),
			declared: snap(ctr("web", "nginx:1.25", envMap("APP_ENV", "prod"), nil)),
			want: []expectDrift{
				{Type: DriftTypeEnvMismatch, ContainerName: "web", Severity: SeverityWarning, LiveValue: "dev", DeclaredValue: "prod"},
			},
		},
		{
			name:     "env mismatch (critical): API_KEY rotated in declared",
			live:     snap(ctr("api", "myapp:v1", envMap("API_KEY", "xyz"), nil)),
			declared: snap(ctr("api", "myapp:v1", envMap("API_KEY", "abc"), nil)),
			want: []expectDrift{
				{Type: DriftTypeEnvMismatch, ContainerName: "api", Severity: SeverityCritical, LiveValue: "xyz", DeclaredValue: "abc"},
			},
		},
		{
			name:     "env mismatch (critical): declared key missing on live",
			live:     snap(ctr("api", "myapp:v1", envMap(), nil)),
			declared: snap(ctr("api", "myapp:v1", envMap("DB_PASSWORD", "hunter2"), nil)),
			want: []expectDrift{
				{Type: DriftTypeEnvMismatch, ContainerName: "api", Severity: SeverityCritical, LiveValue: "", DeclaredValue: "hunter2"},
			},
		},

		// PortChanged
		{
			name:     "port changed: host port differs",
			live:     snap(ctr("web", "nginx:1.25", nil, []string{"9090:80"})),
			declared: snap(ctr("web", "nginx:1.25", nil, []string{"8080:80"})),
			want: []expectDrift{
				{Type: DriftTypePortChanged, ContainerName: "web", Severity: SeverityWarning, LiveValue: "9090:80", DeclaredValue: "8080:80"},
			},
		},
		{
			name:     "port changed: declared exposes extra port not live",
			live:     snap(ctr("api", "myapp:v1", nil, []string{"3000:3000"})),
			declared: snap(ctr("api", "myapp:v1", nil, []string{"3000:3000", "9000:9000"})),
			want: []expectDrift{
				{Type: DriftTypePortChanged, ContainerName: "api", Severity: SeverityWarning, LiveValue: "3000:3000", DeclaredValue: "3000:3000,9000:9000"},
			},
		},

		// Multiple drifts on one container
		{
			name: "compound: image stale + env mismatch on same container",
			live: snap(ctr("web", "nginx:1.25", envMap("APP_ENV", "dev"), []string{"8080:80"})),
			declared: snap(ctr("web", "nginx:1.26", envMap("APP_ENV", "prod"), []string{"8080:80"})),
			want: []expectDrift{
				{Type: DriftTypeImageStale, ContainerName: "web", Severity: SeverityWarning, LiveValue: "nginx:1.25", DeclaredValue: "nginx:1.26"},
				{Type: DriftTypeEnvMismatch, ContainerName: "web", Severity: SeverityWarning, LiveValue: "dev", DeclaredValue: "prod"},
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := Diff(tc.live, tc.declared)
			require.Len(t, got, len(tc.want), "drift count mismatch: %+v", got)

			actual := make([]expectDrift, 0, len(got))
			for _, e := range got {
				assert.NotEmpty(t, e.ID, "DriftEvent.ID should be populated")
				assert.False(t, e.DetectedAt.IsZero(), "DriftEvent.DetectedAt should be set")
				actual = append(actual, project(e))
			}
			assert.ElementsMatch(t, tc.want, actual)
		})
	}
}

func TestSeverityForEnvKey(t *testing.T) {
	cases := []struct {
		key  string
		want string
	}{
		{"DB_PASSWORD", SeverityCritical},
		{"db_password", SeverityCritical},
		{"API_SECRET", SeverityCritical},
		{"API_KEY", SeverityCritical},
		{"GITHUB_TOKEN", SeverityCritical},
		{"DATABASE_URL", SeverityCritical},
		{"DB_HOST", SeverityCritical},
		{"APP_ENV", SeverityWarning},
		{"LOG_LEVEL", SeverityWarning},
		{"DEBUG", SeverityWarning},
	}
	for _, c := range cases {
		c := c
		t.Run(c.key, func(t *testing.T) {
			assert.Equal(t, c.want, severityForEnvKey(c.key))
		})
	}
}

func TestDiff_HandlesNilSnapshots(t *testing.T) {
	// Both nil: no drifts.
	require.Empty(t, Diff(nil, nil))

	// Only declared: every container missing.
	got := Diff(nil, snap(ctr("web", "nginx:1.25", nil, nil)))
	require.Len(t, got, 1)
	assert.Equal(t, DriftTypeMissingContainer, got[0].Type)

	// Only live: every container extra.
	got = Diff(snap(ctr("web", "nginx:1.25", nil, nil)), nil)
	require.Len(t, got, 1)
	assert.Equal(t, DriftTypeExtraContainer, got[0].Type)
}
