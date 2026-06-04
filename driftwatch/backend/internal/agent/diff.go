package agent

import (
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/souvik-biswas-dev/driftwatch/internal/docker"
)

const (
	DriftTypeEnvMismatch      = "env_mismatch"
	DriftTypeImageStale       = "image_stale"
	DriftTypePortChanged      = "port_changed"
	DriftTypeMissingContainer = "missing_container"
	DriftTypeExtraContainer   = "extra_container"
)

const (
	SeverityCritical = "critical"
	SeverityWarning  = "warning"
	SeverityInfo     = "info"
)

type DriftEvent struct {
	ID            string
	Type          string
	ContainerName string
	LiveValue     string
	DeclaredValue string
	Severity      string
	DetectedAt    time.Time
}

// Diff compares the live and declared snapshots and returns every drift
// event detected. The output ordering is stable: containers are walked in
// alphabetical order, and per-container env keys are walked in sorted order.
func Diff(live, declared *docker.LiveSnapshot) []DriftEvent {
	liveByName := indexByName(live)
	declaredByName := indexByName(declared)

	names := unionNames(liveByName, declaredByName)
	now := time.Now().UTC()

	var events []DriftEvent
	for _, name := range names {
		liveC, inLive := liveByName[name]
		decC, inDeclared := declaredByName[name]

		switch {
		case inDeclared && !inLive:
			events = append(events, DriftEvent{
				ID:            uuid.NewString(),
				Type:          DriftTypeMissingContainer,
				ContainerName: name,
				DeclaredValue: decC.Image,
				Severity:      SeverityCritical,
				DetectedAt:    now,
			})
			continue
		case inLive && !inDeclared:
			events = append(events, DriftEvent{
				ID:            uuid.NewString(),
				Type:          DriftTypeExtraContainer,
				ContainerName: name,
				LiveValue:     liveC.Image,
				Severity:      SeverityInfo,
				DetectedAt:    now,
			})
			continue
		}

		// Image tag — split on ":" and compare the tag half.
		if tagOf(liveC.Image) != tagOf(decC.Image) {
			events = append(events, DriftEvent{
				ID:            uuid.NewString(),
				Type:          DriftTypeImageStale,
				ContainerName: name,
				LiveValue:     liveC.Image,
				DeclaredValue: decC.Image,
				Severity:      SeverityWarning,
				DetectedAt:    now,
			})
		}

		// Env — for every declared key, flag if live missing or differs.
		envKeys := make([]string, 0, len(decC.Env))
		for k := range decC.Env {
			envKeys = append(envKeys, k)
		}
		sort.Strings(envKeys)
		for _, k := range envKeys {
			decVal := decC.Env[k]
			liveVal, ok := liveC.Env[k]
			if !ok || liveVal != decVal {
				events = append(events, DriftEvent{
					ID:            uuid.NewString(),
					Type:          DriftTypeEnvMismatch,
					ContainerName: name,
					LiveValue:     liveVal,
					DeclaredValue: decVal,
					Severity:      severityForEnvKey(k),
					DetectedAt:    now,
				})
			}
		}

		// Ports — declared set must be a subset of live set.
		liveSet := make(map[string]struct{}, len(liveC.Ports))
		for _, p := range liveC.Ports {
			liveSet[p] = struct{}{}
		}
		missing := false
		for _, p := range decC.Ports {
			if _, ok := liveSet[p]; !ok {
				missing = true
				break
			}
		}
		if missing {
			events = append(events, DriftEvent{
				ID:            uuid.NewString(),
				Type:          DriftTypePortChanged,
				ContainerName: name,
				LiveValue:     strings.Join(liveC.Ports, ","),
				DeclaredValue: strings.Join(decC.Ports, ","),
				Severity:      SeverityWarning,
				DetectedAt:    now,
			})
		}
	}

	return events
}

func indexByName(s *docker.LiveSnapshot) map[string]docker.ContainerState {
	out := make(map[string]docker.ContainerState)
	if s == nil {
		return out
	}
	for _, c := range s.Containers {
		out[c.Name] = c
	}
	return out
}

func unionNames(a, b map[string]docker.ContainerState) []string {
	set := make(map[string]struct{}, len(a)+len(b))
	for n := range a {
		set[n] = struct{}{}
	}
	for n := range b {
		set[n] = struct{}{}
	}
	out := make([]string, 0, len(set))
	for n := range set {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// tagOf returns the tag portion of a docker image reference. It splits on
// the last ":" so registries with a port ("registry:5000/img:tag") work,
// and falls back to "latest" when no tag is present.
func tagOf(image string) string {
	idx := strings.LastIndex(image, ":")
	if idx == -1 {
		return "latest"
	}
	return image[idx+1:]
}

func severityForEnvKey(key string) string {
	up := strings.ToUpper(key)
	for _, trigger := range []string{"PASSWORD", "SECRET", "KEY", "TOKEN", "DATABASE", "DB"} {
		if strings.Contains(up, trigger) {
			return SeverityCritical
		}
	}
	return SeverityWarning
}
