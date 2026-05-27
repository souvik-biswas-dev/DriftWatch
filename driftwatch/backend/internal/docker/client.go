package docker

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/client"
)

type ContainerState struct {
	Name    string            `json:"name"`
	Image   string            `json:"image"`
	Env     map[string]string `json:"env"`
	Ports   []string          `json:"ports"`
	Running bool              `json:"running"`
}

type LiveSnapshot struct {
	Containers []ContainerState `json:"containers"`
	CapturedAt time.Time        `json:"captured_at"`
}

// containerLister is the subset of the docker SDK we depend on.
// *client.Client satisfies it in production; tests inject a fake.
type containerLister interface {
	ContainerList(ctx context.Context, opts types.ContainerListOptions) ([]types.Container, error)
}

type Client struct {
	api containerLister
}

func NewClient(dockerHost string) (*Client, error) {
	dc, err := client.NewClientWithOpts(
		client.WithHost(dockerHost),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, fmt.Errorf("docker: connect to %s: %w", dockerHost, err)
	}
	return &Client{api: dc}, nil
}

func (c *Client) FetchLiveState(ctx context.Context) (*LiveSnapshot, error) {
	containers, err := c.api.ContainerList(ctx, types.ContainerListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("docker: list containers: %w", err)
	}

	snap := &LiveSnapshot{
		Containers: make([]ContainerState, 0, len(containers)),
		CapturedAt: time.Now().UTC(),
	}

	for _, ctr := range containers {
		name := ""
		if len(ctr.Names) > 0 {
			name = strings.TrimPrefix(ctr.Names[0], "/")
		}

		env := make(map[string]string, len(ctr.Labels))
		for k, v := range ctr.Labels {
			env[k] = v
		}

		ports := make([]string, 0, len(ctr.Ports))
		for _, p := range ctr.Ports {
			ports = append(ports, fmt.Sprintf("%d:%d", p.PublicPort, p.PrivatePort))
		}

		snap.Containers = append(snap.Containers, ContainerState{
			Name:    name,
			Image:   ctr.Image,
			Env:     env,
			Ports:   ports,
			Running: ctr.State == "running",
		})
	}

	return snap, nil
}
