package docker

import (
	"context"
	"testing"

	"github.com/docker/docker/api/types"
	"github.com/stretchr/testify/assert"
)

type fakeLister struct {
	containers []types.Container
	err        error
}

func (f *fakeLister) ContainerList(ctx context.Context, opts types.ContainerListOptions) ([]types.Container, error) {
	return f.containers, f.err
}

func TestFetchLiveState_ShapesContainerState(t *testing.T) {
	fake := &fakeLister{
		containers: []types.Container{
			{
				Names: []string{"/web"},
				Image: "nginx:1.25",
				State: "running",
				Labels: map[string]string{
					"APP_ENV": "production",
					"VERSION": "1.0.0",
				},
				Ports: []types.Port{
					{PublicPort: 8080, PrivatePort: 80},
				},
			},
			{
				Names: []string{"/worker"},
				Image: "redis:7",
				State: "exited",
				Labels: map[string]string{},
				Ports:  []types.Port{},
			},
		},
	}

	c := &Client{api: fake}
	snap, err := c.FetchLiveState(context.Background())

	assert.NoError(t, err)
	assert.NotNil(t, snap)
	assert.False(t, snap.CapturedAt.IsZero())
	assert.Len(t, snap.Containers, 2)

	web := snap.Containers[0]
	assert.Equal(t, "web", web.Name)
	assert.Equal(t, "nginx:1.25", web.Image)
	assert.True(t, web.Running)
	assert.Equal(t, "production", web.Env["APP_ENV"])
	assert.Equal(t, "1.0.0", web.Env["VERSION"])
	assert.Equal(t, []string{"8080:80"}, web.Ports)

	worker := snap.Containers[1]
	assert.Equal(t, "worker", worker.Name)
	assert.False(t, worker.Running)
	assert.Empty(t, worker.Ports)
}
